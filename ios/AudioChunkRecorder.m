//
// AudioChunkRecorder.m
//
// Continuous-capture implementation backed by AVAudioEngine. Instead of
// rotating AVAudioRecorder instances per chunk (which left audible gaps
// between chunks), this module taps the input node and slices the live PCM
// stream into chunk WAV files in software, then emits the full continuous
// recording on stop.
//
#import "AudioChunkRecorder.h"
#import <AVFoundation/AVFoundation.h>

static NSString * const kRecorderErrorDomain = @"AudioChunkRecorder";
static const double      kDefaultSampleRate = 16000.0;
static const NSInteger   kDefaultChunkSecs  = 30;
static const NSInteger   kBytesPerSample    = 2; // 16-bit mono

@interface AudioChunkRecorder ()
@property (nonatomic, strong) AVAudioEngine *engine;
@property (nonatomic, strong) AVAudioConverter *converter;
@property (nonatomic, strong) AVAudioFormat *outputFormat; // mono int16 @ sampleRate
@property (nonatomic, strong) NSMutableData *chunkBuffer;
@property (nonatomic, strong) NSMutableData *fullBuffer;
@property (nonatomic, strong) dispatch_queue_t bufferQueue;
@property (nonatomic)            dispatch_source_t maxDurationTimer;
@property (nonatomic)            NSInteger seq;
@property (nonatomic)            double sampleRate;
@property (nonatomic)            NSInteger chunkSeconds;
@property (nonatomic)            NSInteger chunkSizeBytes;
@property (nonatomic)            NSTimeInterval maxRecordingDuration;
@property (nonatomic)            NSTimeInterval recordingStartTime;
@property (nonatomic)            NSTimeInterval currentChunkStartTime;
@property (nonatomic)            BOOL isRecording;
@property (nonatomic)            BOOL isPaused;
@property (nonatomic)            BOOL interruptionEventSent;
@property (nonatomic)            NSTimeInterval lastInterruptionEndTime;
@property (nonatomic, strong)    NSTimer *audioLevelEmitterTimer; // for fallback level emit
@property (nonatomic)            double lastEmittedLevel;
@end

@implementation AudioChunkRecorder

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSArray<NSString *> *)supportedEvents {
    return @[
        @"onChunkReady",
        @"onError",
        @"onAudioLevel",
        @"onInterruption",
        @"onStateChange",
        @"onMaxDurationReached",
        @"onFullRecordingReady",
    ];
}

#pragma mark - Public API

RCT_EXPORT_METHOD(startRecording:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    if (self.isRecording) {
        reject(@"already_recording", @"Recording is already in progress", nil);
        return;
    }
    [self resetState];

    self.sampleRate           = [options[@"sampleRate"] doubleValue]   ?: kDefaultSampleRate;
    self.chunkSeconds         = [options[@"chunkSeconds"] integerValue] ?: kDefaultChunkSecs;
    self.maxRecordingDuration = [options[@"maxRecordingDuration"] doubleValue] ?: 7200.0;
    self.chunkSizeBytes       = (NSInteger)(self.sampleRate * kBytesPerSample * self.chunkSeconds);
    self.seq                  = 1;
    self.isPaused             = NO;
    self.interruptionEventSent = NO;
    self.lastInterruptionEndTime = 0;
    self.recordingStartTime   = [NSDate timeIntervalSinceReferenceDate];
    self.currentChunkStartTime = self.recordingStartTime;
    self.chunkBuffer          = [NSMutableData data];
    self.fullBuffer           = [NSMutableData data];
    self.bufferQueue          = dispatch_queue_create("com.audiochunkrecorder.buffer", DISPATCH_QUEUE_SERIAL);

    AVAudioSessionRecordPermission perm = [[AVAudioSession sharedInstance] recordPermission];
    if (perm != AVAudioSessionRecordPermissionGranted) {
        reject(@"permission_denied", @"Microphone permission not granted", nil);
        return;
    }

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSError *error = nil;
        if (![self configureAudioSession:&error] || ![self startEngine:&error]) {
            reject(@"start_failed", error.localizedDescription ?: @"Failed to start recording", error);
            return;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            self.isRecording = YES;
            [self emitStateChange];
        });

        [self setupAudioSessionNotifications];
        [self startMaxDurationTracking];
        resolve(@"Recording started");
    });
}

RCT_EXPORT_METHOD(stopRecording:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    if (!self.isRecording) {
        if (reject) reject(@"not_recording", @"No recording in progress", nil);
        return;
    }
    self.isRecording = NO;
    [self emitStateChange];

    self.interruptionEventSent = NO;
    self.lastInterruptionEndTime = 0;
    [self removeAudioSessionNotifications];
    [self stopMaxDurationTracking];
    [self stopEngine];

    // Flush the remaining bytes as the final chunk, then emit the full recording.
    dispatch_async(self.bufferQueue, ^{
        [self flushFinalChunk];
        [self emitFullRecording];
        [self resetState];
        if (resolve) resolve(@"Recording stopped");
    });
}

RCT_EXPORT_METHOD(pauseRecording:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    if (!self.isRecording || self.isPaused) {
        reject(@"invalid_state", @"Cannot pause - not recording or already paused", nil);
        return;
    }
    self.isPaused = YES;
    [self emitStateChange];
    if (self.engine.isRunning) [self.engine pause];
    resolve(@"Recording paused");
}

RCT_EXPORT_METHOD(resumeRecording:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    if (!self.isRecording || !self.isPaused) {
        reject(@"invalid_state", @"Cannot resume - not recording or not paused", nil);
        return;
    }
    self.isPaused = NO;
    [self emitStateChange];

    NSError *error = nil;
    if (![self.engine startAndReturnError:&error]) {
        reject(@"resume_failed", error.localizedDescription ?: @"Failed to resume engine", error);
        return;
    }
    resolve(@"Recording resumed");
}

RCT_EXPORT_METHOD(checkPermissions:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    AVAudioSession *session = [AVAudioSession sharedInstance];
    switch (session.recordPermission) {
        case AVAudioSessionRecordPermissionGranted: resolve(@(YES)); break;
        case AVAudioSessionRecordPermissionDenied:  resolve(@(NO));  break;
        case AVAudioSessionRecordPermissionUndetermined:
            [session requestRecordPermission:^(BOOL granted) { resolve(@(granted)); }];
            break;
        default: resolve(@(NO)); break;
    }
}

RCT_EXPORT_METHOD(isAvailable:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    resolve(@(YES));
}

RCT_EXPORT_METHOD(isRecording:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    resolve(@(self.isRecording));
}

RCT_EXPORT_METHOD(getAudioRecordState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    NSTimeInterval elapsed = self.recordingStartTime > 0 ? (now - self.recordingStartTime) : 0;
    NSTimeInterval remaining = self.maxRecordingDuration > 0 ? (self.maxRecordingDuration - elapsed) : 0;
    resolve(@{
        @"isRecording": @(self.isRecording),
        @"isPaused": @(self.isPaused),
        @"seq": @(self.seq),
        @"sampleRate": @(self.sampleRate),
        @"chunkSeconds": @(self.chunkSeconds),
        @"maxRecordingDuration": @(self.maxRecordingDuration),
        @"elapsedRecordingTime": @(elapsed),
        @"remainingTime": @(remaining),
    });
}

RCT_EXPORT_METHOD(clearAllChunkFiles:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSFileManager *fm = [NSFileManager defaultManager];
        NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
        NSError *err = nil;
        NSArray *files = [fm contentsOfDirectoryAtPath:docs error:&err];
        if (err) { reject(@"FILE_ERROR", @"Could not read documents directory", err); return; }
        NSInteger deleted = 0;
        for (NSString *name in files) {
            BOOL match = ([name hasPrefix:@"chunk_"] && ([name hasSuffix:@".wav"] || [name hasSuffix:@".m4a"]))
                       || ([name hasPrefix:@"full_"] && [name hasSuffix:@".wav"]);
            if (!match) continue;
            NSString *path = [docs stringByAppendingPathComponent:name];
            if ([fm removeItemAtPath:path error:nil]) deleted++;
        }
        resolve([NSString stringWithFormat:@"Deleted %ld files", (long)deleted]);
    });
}

#pragma mark - Audio Session / Engine

- (BOOL)configureAudioSession:(NSError **)outError {
    AVAudioSession *session = [AVAudioSession sharedInstance];
    BOOL ok = [session setCategory:AVAudioSessionCategoryPlayAndRecord
                       withOptions:AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionDefaultToSpeaker
                             error:outError] &&
              [session setPreferredSampleRate:self.sampleRate error:outError] &&
              [session setActive:YES error:outError];
    if (!ok) return NO;
    if (session.sampleRate != self.sampleRate) {
        self.sampleRate = session.sampleRate;
        self.chunkSizeBytes = (NSInteger)(self.sampleRate * kBytesPerSample * self.chunkSeconds);
    }
    return YES;
}

- (BOOL)startEngine:(NSError **)outError {
    self.engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = self.engine.inputNode;
    AVAudioFormat *inputFormat = [input inputFormatForBus:0];

    // Target: mono int16 PCM at the requested sample rate.
    self.outputFormat = [[AVAudioFormat alloc]
                         initWithCommonFormat:AVAudioPCMFormatInt16
                         sampleRate:self.sampleRate
                         channels:1
                         interleaved:YES];

    self.converter = [[AVAudioConverter alloc] initFromFormat:inputFormat toFormat:self.outputFormat];
    if (!self.converter) {
        if (outError) {
            *outError = [NSError errorWithDomain:kRecorderErrorDomain code:2001
                                        userInfo:@{NSLocalizedDescriptionKey: @"Failed to create AVAudioConverter"}];
        }
        return NO;
    }

    __weak typeof(self) weakSelf = self;
    [input installTapOnBus:0 bufferSize:4096 format:inputFormat usingBlock:^(AVAudioPCMBuffer * _Nonnull buffer, AVAudioTime * _Nonnull when) {
        __strong typeof(weakSelf) strongSelf = weakSelf;
        if (!strongSelf || strongSelf.isPaused || !strongSelf.isRecording) return;
        [strongSelf handleInputBuffer:buffer];
    }];

    return [self.engine startAndReturnError:outError];
}

- (void)stopEngine {
    @try {
        if (self.engine) {
            [self.engine.inputNode removeTapOnBus:0];
            if (self.engine.isRunning) [self.engine stop];
        }
    } @catch (NSException *e) {
        NSLog(@"AudioChunkRecorder: Error stopping engine: %@", e);
    }
    self.engine = nil;
    self.converter = nil;
}

#pragma mark - Audio Processing

- (void)handleInputBuffer:(AVAudioPCMBuffer *)inputBuffer {
    // Convert to int16 mono @ self.sampleRate.
    AVAudioFrameCount outCapacity = (AVAudioFrameCount)(inputBuffer.frameLength *
                                                       (self.outputFormat.sampleRate / inputBuffer.format.sampleRate) + 64);
    AVAudioPCMBuffer *outBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:self.outputFormat
                                                                frameCapacity:outCapacity];
    if (!outBuffer) return;

    __block BOOL provided = NO;
    AVAudioConverterInputBlock inputBlock = ^AVAudioBuffer * _Nullable(AVAudioPacketCount inNumberOfPackets,
                                                                       AVAudioConverterInputStatus * _Nonnull outStatus) {
        if (provided) {
            *outStatus = AVAudioConverterInputStatus_NoDataNow;
            return nil;
        }
        provided = YES;
        *outStatus = AVAudioConverterInputStatus_HaveData;
        return inputBuffer;
    };

    NSError *convErr = nil;
    AVAudioConverterOutputStatus status = [self.converter convertToBuffer:outBuffer
                                                                    error:&convErr
                                                       withInputFromBlock:inputBlock];
    if (status == AVAudioConverterOutputStatus_Error || outBuffer.frameLength == 0) {
        if (convErr) NSLog(@"AudioChunkRecorder: convert error: %@", convErr);
        return;
    }

    int16_t *samples = (int16_t *)outBuffer.int16ChannelData[0];
    NSUInteger byteCount = outBuffer.frameLength * sizeof(int16_t);
    NSData *pcmChunk = [NSData dataWithBytes:samples length:byteCount];

    // Audio level (RMS).
    double sumSq = 0;
    for (NSUInteger i = 0; i < outBuffer.frameLength; i++) {
        double s = (double)samples[i];
        sumSq += s * s;
    }
    double rms = sqrt(sumSq / MAX(1u, outBuffer.frameLength)) / 32768.0;
    if (rms > 1.0) rms = 1.0;
    if (fabs(rms - self.lastEmittedLevel) >= 0.02) {
        self.lastEmittedLevel = rms;
        [self sendEventWithName:@"onAudioLevel" body:@{
            @"level": @(rms),
            @"hasAudio": @(rms > 0.01),
        }];
    }

    dispatch_async(self.bufferQueue, ^{
        if (!self.chunkBuffer || !self.fullBuffer) return;
        [self.chunkBuffer appendData:pcmChunk];
        [self.fullBuffer appendData:pcmChunk];

        while (self.chunkSizeBytes > 0 && (NSInteger)self.chunkBuffer.length >= self.chunkSizeBytes) {
            NSRange head = NSMakeRange(0, self.chunkSizeBytes);
            NSData *chunk = [self.chunkBuffer subdataWithRange:head];
            NSData *leftover = self.chunkBuffer.length > (NSUInteger)self.chunkSizeBytes
                ? [self.chunkBuffer subdataWithRange:NSMakeRange(self.chunkSizeBytes,
                                                                  self.chunkBuffer.length - self.chunkSizeBytes)]
                : nil;
            self.chunkBuffer = [NSMutableData dataWithData:leftover ?: [NSData data]];

            NSInteger idx = self.seq;
            self.seq += 1;
            NSTimeInterval startedAt = self.currentChunkStartTime;
            self.currentChunkStartTime = [NSDate timeIntervalSinceReferenceDate];
            [self emitChunk:chunk index:idx startedAt:startedAt isLast:NO];
        }
    });
}

- (void)flushFinalChunk {
    if (!self.chunkBuffer || self.chunkBuffer.length == 0) return;
    NSData *tail = [self.chunkBuffer copy];
    self.chunkBuffer = [NSMutableData data];
    NSInteger idx = self.seq;
    self.seq += 1;
    [self emitChunk:tail index:idx startedAt:self.currentChunkStartTime isLast:YES];
}

- (void)emitChunk:(NSData *)pcm index:(NSInteger)idx startedAt:(NSTimeInterval)startedAt isLast:(BOOL)isLast {
    NSString *path = [self writeWavWithPCM:pcm sampleRate:(int)self.sampleRate name:[NSString stringWithFormat:@"chunk_%04ld.wav", (long)idx]];
    if (!path) {
        [self emitErrorWithCode:1007 message:[NSString stringWithFormat:@"Failed to write chunk %ld", (long)idx]];
        return;
    }
    [self sendEventWithName:@"onChunkReady" body:@{
        @"path": path,
        @"sequence": @(idx),
        @"timestamp": @(startedAt * 1000.0),
        @"size": @(pcm.length),
        @"isLastChunk": @(isLast),
    }];
}

- (void)emitFullRecording {
    if (!self.fullBuffer || self.fullBuffer.length == 0) return;
    NSString *name = [NSString stringWithFormat:@"full_%lld.wav", (long long)([[NSDate date] timeIntervalSince1970] * 1000)];
    NSString *path = [self writeWavWithPCM:self.fullBuffer sampleRate:(int)self.sampleRate name:name];
    if (!path) {
        [self emitErrorWithCode:1010 message:@"Failed to write full recording"];
        return;
    }
    double duration = ((double)self.fullBuffer.length / (double)kBytesPerSample) / self.sampleRate;
    [self sendEventWithName:@"onFullRecordingReady" body:@{
        @"path": path,
        @"timestamp": @(self.recordingStartTime * 1000.0),
        @"size": @(self.fullBuffer.length),
        @"durationSeconds": @(duration),
    }];
    self.fullBuffer = nil;
}

#pragma mark - WAV writing

- (NSString *)writeWavWithPCM:(NSData *)pcm sampleRate:(int)sampleRate name:(NSString *)name {
    NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    NSString *path = [docs stringByAppendingPathComponent:name];

    NSMutableData *wav = [NSMutableData dataWithCapacity:44 + pcm.length];
    uint32_t dataSize = (uint32_t)pcm.length;
    uint32_t riffSize = 36 + dataSize;
    uint16_t channels = 1;
    uint16_t bitsPerSample = 16;
    uint32_t byteRate = (uint32_t)(sampleRate * channels * bitsPerSample / 8);
    uint16_t blockAlign = (uint16_t)(channels * bitsPerSample / 8);
    uint32_t fmtSize = 16;
    uint16_t audioFormat = 1; // PCM

    [wav appendBytes:"RIFF" length:4];
    [wav appendBytes:&riffSize length:4];
    [wav appendBytes:"WAVE" length:4];
    [wav appendBytes:"fmt " length:4];
    [wav appendBytes:&fmtSize length:4];
    [wav appendBytes:&audioFormat length:2];
    [wav appendBytes:&channels length:2];
    [wav appendBytes:&sampleRate length:4];
    [wav appendBytes:&byteRate length:4];
    [wav appendBytes:&blockAlign length:2];
    [wav appendBytes:&bitsPerSample length:2];
    [wav appendBytes:"data" length:4];
    [wav appendBytes:&dataSize length:4];
    [wav appendData:pcm];

    NSError *err = nil;
    if (![wav writeToFile:path options:NSDataWritingAtomic error:&err]) {
        NSLog(@"AudioChunkRecorder: write WAV failed: %@", err);
        return nil;
    }
    return path;
}

#pragma mark - Max duration tracking

- (void)startMaxDurationTracking {
    if (self.maxDurationTimer) dispatch_source_cancel(self.maxDurationTimer);
    if (self.maxRecordingDuration <= 0) return;

    self.maxDurationTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                                   dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0));
    dispatch_source_set_timer(self.maxDurationTimer,
                              dispatch_time(DISPATCH_TIME_NOW, self.maxRecordingDuration * NSEC_PER_SEC),
                              DISPATCH_TIME_FOREVER, 0);
    __weak typeof(self) weakSelf = self;
    dispatch_source_set_event_handler(self.maxDurationTimer, ^{ [weakSelf handleMaxDurationReached]; });
    dispatch_resume(self.maxDurationTimer);
}

- (void)stopMaxDurationTracking {
    if (self.maxDurationTimer) {
        dispatch_source_cancel(self.maxDurationTimer);
        self.maxDurationTimer = nil;
    }
}

- (void)handleMaxDurationReached {
    if (!self.isRecording) return;
    NSTimeInterval total = [NSDate timeIntervalSinceReferenceDate] - self.recordingStartTime;

    [self stopRecording:^(id _){
        [self sendEventWithName:@"onMaxDurationReached" body:@{
            @"duration": @(total),
            @"maxDuration": @(self.maxRecordingDuration),
        }];
    } rejecter:^(NSString *c, NSString *m, NSError *e){}];
}

#pragma mark - Audio Session notifications

- (void)setupAudioSessionNotifications {
    NSNotificationCenter *c = [NSNotificationCenter defaultCenter];
    [c addObserver:self selector:@selector(handleAudioSessionInterruption:)
              name:AVAudioSessionInterruptionNotification object:[AVAudioSession sharedInstance]];
    [c addObserver:self selector:@selector(handleAudioSessionRouteChange:)
              name:AVAudioSessionRouteChangeNotification object:[AVAudioSession sharedInstance]];
}

- (void)removeAudioSessionNotifications {
    [[NSNotificationCenter defaultCenter] removeObserver:self name:AVAudioSessionInterruptionNotification object:nil];
    [[NSNotificationCenter defaultCenter] removeObserver:self name:AVAudioSessionRouteChangeNotification object:nil];
}

- (void)handleAudioSessionInterruption:(NSNotification *)notification {
    if (!self.isRecording) return;
    AVAudioSessionInterruptionType type = [notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];

    if (type == AVAudioSessionInterruptionTypeBegan) {
        BOOL wasRecording = self.isRecording && !self.isPaused;
        if (!self.interruptionEventSent && wasRecording) {
            self.isPaused = YES;
            [self emitStateChange];
            if (self.engine.isRunning) [self.engine pause];
            [self sendEventWithName:@"onInterruption" body:@{
                @"type": @"began",
                @"reason": @"phone_call_or_other_app",
                @"wasRecording": @(YES),
                @"nativePaused": @(YES),
            }];
            self.interruptionEventSent = YES;
            self.lastInterruptionEndTime = 0;
        }
    } else if (type == AVAudioSessionInterruptionTypeEnded) {
        NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
        if (now - self.lastInterruptionEndTime < 1.0) return;
        if (self.interruptionEventSent) {
            AVAudioSessionInterruptionOptions opts = [notification.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue];
            BOOL shouldResume = (opts & AVAudioSessionInterruptionOptionShouldResume) != 0;
            self.lastInterruptionEndTime = now;
            [self sendEventWithName:@"onInterruption" body:@{
                @"type": @"ended",
                @"shouldResume": @(shouldResume),
                @"canResume": @(self.isRecording && self.isPaused),
            }];
            self.interruptionEventSent = NO;
        }
    }
}

- (void)handleAudioSessionRouteChange:(NSNotification *)notification {
    if (!self.isRecording) return;
    AVAudioSessionRouteChangeReason reason = [notification.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue];
    if (reason == AVAudioSessionRouteChangeReasonOldDeviceUnavailable) {
        BOOL wasRecording = self.isRecording && !self.isPaused;
        if (!self.interruptionEventSent && wasRecording) {
            self.isPaused = YES;
            [self emitStateChange];
            if (self.engine.isRunning) [self.engine pause];
            [self sendEventWithName:@"onInterruption" body:@{
                @"type": @"audioDeviceDisconnected",
                @"reason": @"headphones_or_bluetooth_disconnected",
                @"nativePaused": @(YES),
            }];
            self.interruptionEventSent = YES;
        }
    }
}

#pragma mark - Helpers

- (void)emitStateChange {
    [self sendEventWithName:@"onStateChange" body:@{
        @"isRecording": @(self.isRecording),
        @"isPaused": @(self.isPaused),
    }];
}

- (void)emitErrorWithCode:(NSInteger)code message:(NSString *)message {
    [self sendEventWithName:@"onError" body:@{@"message": message ?: @"Unknown error", @"code": @(code)}];
}

- (void)resetState {
    if (self.maxDurationTimer) { dispatch_source_cancel(self.maxDurationTimer); self.maxDurationTimer = nil; }
    [self stopEngine];
    self.isPaused = NO;
    self.interruptionEventSent = NO;
    self.lastInterruptionEndTime = 0;
    self.recordingStartTime = 0;
    self.chunkBuffer = nil;
    self.fullBuffer = nil;
    [[AVAudioSession sharedInstance] setActive:NO
                                   withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                         error:nil];
}

@end
