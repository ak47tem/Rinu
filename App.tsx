import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { VideoQuality, ConnectionState } from './types';
import { VideoIcon, VideoSlashIcon, PhoneIcon, PhoneXMarkIcon, SettingsIcon, SparklesIcon, PipIcon, LockClosedIcon, ArrowRightIcon, ArrowRightOnRectangleIcon, UserIcon, XMarkIcon, ScreenShareIcon, StopScreenShareIcon, Bars3Icon, PaletteIcon, CogIcon } from './components/Icons';
import { Visualizer } from './components/Visualizer';

// Audio decoding helper
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Audio decoding helper
async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// PCM Encoder
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Blob creator for PCM
function createBlob(data: Float32Array): any {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

// Convert blob to base64
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      } else {
        reject(new Error("Failed to convert blob to base64"));
      }
    };
    reader.readAsDataURL(blob);
  });
}

// --- Filters Definition ---
const FILTERS = [
  { name: 'NORMAL', value: 'none', class: '' },
  { name: 'MATRIX', value: 'hue-rotate(90deg) contrast(1.2) brightness(0.9)', class: 'hue-rotate-90' },
  { name: 'B&W', value: 'grayscale(1) contrast(1.2)', class: 'grayscale' },
  { name: 'NIGHT', value: 'sepia(1) hue-rotate(100deg) saturate(3)', class: 'sepia hue-rotate-90' }, // Night vision style
  { name: 'TERMINAL', value: 'contrast(1.5) saturate(0)', class: 'contrast-150' },
  { name: 'INVERT', value: 'invert(1)', class: 'invert' },
];

// --- Theme Definition ---
const THEMES = [
  { name: 'Hacker Green', color: '#00ff41', glow: 'rgba(0, 255, 65, 0.7)', dim: 'rgba(0, 255, 65, 0.1)' },
  { name: 'Cyber Blue', color: '#00e5ff', glow: 'rgba(0, 229, 255, 0.7)', dim: 'rgba(0, 229, 255, 0.1)' },
  { name: 'Crimson Red', color: '#ff003c', glow: 'rgba(255, 0, 60, 0.7)', dim: 'rgba(255, 0, 60, 0.1)' },
  { name: 'Neon Purple', color: '#d000ff', glow: 'rgba(208, 0, 255, 0.7)', dim: 'rgba(208, 0, 255, 0.1)' },
  { name: 'Amber Orange', color: '#ffae00', glow: 'rgba(255, 174, 0, 0.7)', dim: 'rgba(255, 174, 0, 0.1)' },
];

const App: React.FC = () => {
  // --- Auth State ---
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [authStep, setAuthStep] = useState<'phone' | 'otp'>('phone');
  const [countryCode, setCountryCode] = useState('+880');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otpInput, setOtpInput] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  
  // --- User Profile State ---
  const [userName, setUserName] = useState('');
  const [storedPhone, setStoredPhone] = useState('');

  // --- App State ---
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(VideoQuality.HD);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAiTalking, setIsAiTalking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Screen Share State
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  
  // Filter State
  const [activeFilter, setActiveFilter] = useState<string>('none');
  const [showFilters, setShowFilters] = useState(false);

  // --- Sidebar & Customization State ---
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [themeIndex, setThemeIndex] = useState(0);
  const [showGrid, setShowGrid] = useState(true);
  const [showScanlines, setShowScanlines] = useState(true);

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Audio Contexts & Processing
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  
  // Streams
  const streamRef = useRef<MediaStream | null>(null); // Camera + Mic Stream
  const screenStreamRef = useRef<MediaStream | null>(null); // Screen Share Stream

  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Gemini API
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const activeFilterRef = useRef<string>('none');

  // --- Theme Effect ---
  useEffect(() => {
    const theme = THEMES[themeIndex];
    document.documentElement.style.setProperty('--theme-color', theme.color);
    document.documentElement.style.setProperty('--theme-color-glow', theme.glow);
    document.documentElement.style.setProperty('--theme-color-dim', theme.dim);
  }, [themeIndex]);

  // --- Auth Logic ---
  useEffect(() => {
    // Check for saved session
    const savedUserStr = localStorage.getItem('rinu_user');
    if (savedUserStr) {
        const savedUser = JSON.parse(savedUserStr);
        setIsAuthenticated(true);
        setStoredPhone(savedUser.phone || '');
        if (savedUser.name) setUserName(savedUser.name);
    }
    
    // Check saved theme preferences
    const savedTheme = localStorage.getItem('rinu_theme');
    if (savedTheme) {
        const pref = JSON.parse(savedTheme);
        setThemeIndex(pref.themeIndex ?? 0);
        setShowGrid(pref.showGrid ?? true);
        setShowScanlines(pref.showScanlines ?? true);
    }
  }, []);

  // Save theme settings on change
  useEffect(() => {
      localStorage.setItem('rinu_theme', JSON.stringify({
          themeIndex,
          showGrid,
          showScanlines
      }));
  }, [themeIndex, showGrid, showScanlines]);

  const handleSendOtp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber || phoneNumber.length < 10) {
        setErrorMsg("INVALID_NUMBER_FORMAT");
        return;
    }
    setErrorMsg(null);
    setIsAuthLoading(true);
    
    // Simulate API call
    setTimeout(() => {
        setIsAuthLoading(false);
        setAuthStep('otp');
    }, 1500);
  };

  const handleVerifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpInput || otpInput.length < 4) {
        setErrorMsg("INVALID_ACCESS_CODE");
        return;
    }
    
    setIsAuthLoading(true);
    // Simulate verification
    setTimeout(() => {
        setIsAuthLoading(false);
        const fullNumber = countryCode + phoneNumber;
        const userData = { phone: fullNumber, name: '' };
        localStorage.setItem('rinu_user', JSON.stringify(userData));
        setStoredPhone(fullNumber);
        setIsAuthenticated(true);
        setErrorMsg(null);
    }, 1500);
  };

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const userData = { phone: storedPhone, name: userName };
    localStorage.setItem('rinu_user', JSON.stringify(userData));
    // Close sidebar if open for specific reason, but here we keep it or can show a toast
  };

  const handleLogout = () => {
    stopSession();
    localStorage.removeItem('rinu_user');
    setIsAuthenticated(false);
    setIsSidebarOpen(false);
    setAuthStep('phone');
    setPhoneNumber('');
    setOtpInput('');
    setUserName('');
    setStoredPhone('');
  };

  // --- App Logic ---

  useEffect(() => {
    activeFilterRef.current = activeFilter;
  }, [activeFilter]);

  const getConstraints = (quality: VideoQuality) => {
    let width, height;
    switch (quality) {
      case VideoQuality.UHD:
        width = 3840; height = 2160;
        break;
      case VideoQuality.HD:
        width = 1280; height = 720;
        break;
      case VideoQuality.SD:
      default:
        width = 640; height = 480;
        break;
    }
    return {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
      },
      video: {
        width: { ideal: width },
        height: { ideal: height },
        facingMode: "user"
      }
    };
  };

  const startCamera = async (quality: VideoQuality) => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }

      // If screen sharing was active, stop it when changing camera settings
      if (isScreenSharing) {
          stopScreenShare();
      }

      const constraints = getConstraints(quality);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      setErrorMsg("CAMERA_ACCESS_DENIED");
    }
  };

  // Only start camera if authenticated
  useEffect(() => {
    if (isAuthenticated) {
        startCamera(videoQuality);
    }
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [videoQuality, isAuthenticated]);

  const toggleScreenShare = async () => {
    if (isScreenSharing) {
        stopScreenShare();
    } else {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            screenStreamRef.current = screenStream;
            
            // Handle user stopping via browser UI
            screenStream.getVideoTracks()[0].onended = () => {
                stopScreenShare();
            };

            if (videoRef.current) {
                videoRef.current.srcObject = screenStream;
            }
            
            // Disable camera video track to save resources and indicate switch
            if (streamRef.current) {
                streamRef.current.getVideoTracks().forEach(track => track.enabled = false);
            }

            setIsScreenSharing(true);
            // Ensure video sending is enabled so we see the screen
            if (!isVideoEnabled) setIsVideoEnabled(true);

        } catch (err) {
            console.error("Error sharing screen:", err);
            // User likely cancelled
        }
    }
  };

  const stopScreenShare = () => {
      if (screenStreamRef.current) {
          screenStreamRef.current.getTracks().forEach(track => track.stop());
          screenStreamRef.current = null;
      }
      
      // Re-enable camera
      if (streamRef.current) {
          streamRef.current.getVideoTracks().forEach(track => track.enabled = true);
          if (videoRef.current) {
              videoRef.current.srcObject = streamRef.current;
          }
      }

      setIsScreenSharing(false);
  };

  const stopSession = useCallback(() => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (inputSourceRef.current) {
      inputSourceRef.current.disconnect();
      inputSourceRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }

    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    sessionPromiseRef.current = null;
    setConnectionState(ConnectionState.DISCONNECTED);
    setIsAiTalking(false);

    if (isScreenSharing) {
        stopScreenShare();
    }

    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(console.error);
    }
  }, [isScreenSharing]);

  const startSession = async () => {
    if (!process.env.API_KEY) {
        setErrorMsg("API_KEY_MISSING");
        return;
    }

    setConnectionState(ConnectionState.CONNECTING);
    setErrorMsg(null);

    try {
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: `You are Rinu, a tactical AI interface. The operator's alias is ${userName || 'User'}. Keep responses concise, robotic but helpful, and mission-oriented.`,
        },
        callbacks: {
          onopen: () => {
            console.log("UPLINK_ESTABLISHED");
            setConnectionState(ConnectionState.CONNECTED);

            if (!streamRef.current || !inputAudioContextRef.current) return;

            // Audio always comes from the mic stream (streamRef), even if screen sharing
            const source = inputAudioContextRef.current.createMediaStreamSource(streamRef.current);
            inputSourceRef.current = source;
            
            const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(processor);
            processor.connect(inputAudioContextRef.current.destination);

            frameIntervalRef.current = window.setInterval(() => {
                if (!videoRef.current || !canvasRef.current || !isVideoEnabled) return;
                
                const canvas = canvasRef.current;
                const video = videoRef.current;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                
                // Only apply filters if not screen sharing (optional, but cleaner for screen sharing)
                if (!isScreenSharing) {
                    ctx.filter = activeFilterRef.current;
                } else {
                    ctx.filter = 'none';
                }
                
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                canvas.toBlob(async (blob) => {
                    if (blob) {
                        const base64Data = await blobToBase64(blob);
                        sessionPromise.then(session => {
                            session.sendRealtimeInput({
                                media: { data: base64Data, mimeType: 'image/jpeg' }
                            });
                        });
                    }
                }, 'image/jpeg', 0.6); 

            }, 500); 
          },
          onmessage: async (message: LiveServerMessage) => {
             const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
             if (base64Audio && outputAudioContextRef.current) {
                setIsAiTalking(true);
                setTimeout(() => setIsAiTalking(false), 500); 

                const ctx = outputAudioContextRef.current;
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                
                try {
                    const audioBuffer = await decodeAudioData(
                        decode(base64Audio),
                        ctx,
                        24000,
                        1
                    );
                    const source = ctx.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(ctx.destination);
                    source.addEventListener('ended', () => {
                        sourcesRef.current.delete(source);
                    });
                    source.start(nextStartTimeRef.current);
                    nextStartTimeRef.current += audioBuffer.duration;
                    sourcesRef.current.add(source);
                } catch (e) {
                    console.error("Audio decode error", e);
                }
             }

             const interrupted = message.serverContent?.interrupted;
             if (interrupted) {
                 sourcesRef.current.forEach(src => src.stop());
                 sourcesRef.current.clear();
                 nextStartTimeRef.current = 0;
                 setIsAiTalking(false);
             }
          },
          onclose: () => {
            stopSession();
          },
          onerror: (e) => {
            setErrorMsg("UPLINK_FAILURE_DETECTED");
            stopSession();
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err) {
      setConnectionState(ConnectionState.ERROR);
      setErrorMsg("CONNECTION_FAILED_RETRY");
      stopSession();
    }
  };

  const handleToggleCall = () => {
    if (connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.CONNECTING) {
      stopSession();
    } else {
      startSession();
    }
  };

  const handleTogglePiP = async () => {
    if (!videoRef.current) return;
    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else {
            await videoRef.current.requestPictureInPicture();
        }
    } catch (error) {
        setErrorMsg("PIP_MODULE_ERROR");
    }
  };

  const handleQualityChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setVideoQuality(e.target.value as VideoQuality);
  };

  // --- Render Auth Screen ---
  if (!isAuthenticated) {
    return (
        <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
            {/* Background elements */}
            <div className={`absolute inset-0 bg-black ${showGrid ? 'bg-grid' : ''} z-0`}></div>
            {showScanlines && <div className="scanlines"></div>}
            
            <div className="w-full max-w-md bg-black border theme-border p-8 relative z-10 theme-shadow border-glow">
                {/* Decorative corners */}
                <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 theme-border"></div>
                <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 theme-border"></div>
                <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 theme-border"></div>
                <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 theme-border"></div>

                <div className="flex flex-col items-center mb-8">
                    <div className="w-20 h-20 border theme-border flex items-center justify-center mb-4 theme-bg-dim animate-pulse">
                        <LockClosedIcon className="w-10 h-10 theme-text" />
                    </div>
                    <h1 className="text-3xl font-bold theme-text tracking-widest text-glow">RINU_SYSTEM</h1>
                    <p className="theme-text opacity-70 text-sm mt-2 text-center font-mono">
                        {authStep === 'phone' ? ">> AUTHENTICATION_REQUIRED <<" : ">> AWAITING_ACCESS_CODE <<"}
                    </p>
                </div>

                {authStep === 'phone' ? (
                    <form onSubmit={handleSendOtp} className="space-y-6">
                        <div>
                            <label className="block text-xs theme-text uppercase tracking-wider mb-2">[ DEVICE_ID ]</label>
                            <div className="flex space-x-0 border theme-border">
                                <select
                                    value={countryCode}
                                    onChange={(e) => setCountryCode(e.target.value)}
                                    className="bg-black theme-text px-3 py-3 outline-none border-r theme-border cursor-pointer text-sm font-bold uppercase"
                                >
                                    <option value="+880">BD +880</option>
                                    <option value="+91">IN +91</option>
                                </select>
                                <input 
                                    type="tel" 
                                    value={phoneNumber}
                                    onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                                    placeholder="17XX-XXXXXX"
                                    className="flex-1 bg-black px-4 py-3 theme-text placeholder-opacity-50 outline-none font-mono"
                                    required
                                />
                            </div>
                        </div>
                        <button 
                            type="submit" 
                            disabled={isAuthLoading}
                            className="w-full theme-bg-dim hover:brightness-110 border theme-border theme-text font-bold py-3 px-4 transition-all flex items-center justify-center hover:theme-shadow disabled:opacity-50"
                        >
                            {isAuthLoading ? (
                                <span className="animate-pulse">>> PROCESSING...</span>
                            ) : (
                                <>
                                    <span>INITIATE_HANDSHAKE</span>
                                    <ArrowRightIcon className="w-4 h-4 ml-2" />
                                </>
                            )}
                        </button>
                    </form>
                ) : (
                    <form onSubmit={handleVerifyOtp} className="space-y-6">
                        <div>
                            <label className="block text-xs theme-text uppercase tracking-wider mb-2">[ ENCRYPTION_KEY ]</label>
                            <input 
                                type="text" 
                                value={otpInput}
                                onChange={(e) => setOtpInput(e.target.value)}
                                placeholder="******"
                                maxLength={6}
                                className="w-full bg-black border theme-border px-4 py-3 theme-text placeholder-opacity-50 outline-none text-center tracking-[0.5em] text-xl font-bold focus:theme-shadow"
                                required
                            />
                        </div>
                        <button 
                            type="submit" 
                            disabled={isAuthLoading}
                            className="w-full theme-bg hover:brightness-110 text-black font-bold py-3 px-4 transition-all flex items-center justify-center hover:theme-shadow disabled:opacity-50"
                        >
                            {isAuthLoading ? (
                                <span className="animate-pulse">>> DECRYPTING...</span>
                            ) : (
                                "ACCESS_SYSTEM"
                            )}
                        </button>
                        <button 
                            type="button"
                            onClick={() => { setAuthStep('phone'); setErrorMsg(null); }}
                            className="w-full theme-text opacity-60 hover:opacity-100 text-xs py-2 uppercase tracking-wide hover:underline"
                        >
                            [ ABORT_SEQUENCE ]
                        </button>
                    </form>
                )}
                
                {errorMsg && (
                    <div className="mt-6 p-2 bg-red-900/20 border border-red-500 text-red-500 text-xs text-center font-mono">
                        >> ERROR: {errorMsg}
                    </div>
                )}
            </div>
        </div>
    );
  }

  // --- Main App Logic ---
  const isConnected = connectionState === ConnectionState.CONNECTED;
  const containerClass = isConnected 
    ? "fixed inset-0 w-full h-full bg-black z-50 flex flex-col"
    : "w-full max-w-4xl relative aspect-video bg-black border theme-border theme-shadow relative z-10";
  
  const controlsClass = isConnected
    ? "absolute bottom-8 left-0 right-0 flex flex-col items-center space-y-4"
    : "mt-8 flex flex-col items-center space-y-4 relative z-10";

  return (
    <div className={`min-h-screen bg-black flex flex-col items-center justify-center ${!isConnected ? 'p-4' : ''}`}>
        <div className={`absolute inset-0 bg-black ${showGrid ? 'bg-grid' : ''} z-0`}></div>
        {showScanlines && <div className="scanlines"></div>}
      
      {/* Wrapper to handle Fullscreen vs Card layout */}
      <div className={containerClass}>
        
        {/* HUD Overlay Elements (Decorative) */}
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-10 opacity-50">
             <div className="absolute top-4 left-4 w-32 h-32 border-t border-l theme-border"></div>
             <div className="absolute top-4 right-4 w-32 h-32 border-t border-r theme-border"></div>
             <div className="absolute bottom-4 left-4 w-32 h-32 border-b border-l theme-border"></div>
             <div className="absolute bottom-4 right-4 w-32 h-32 border-b border-r theme-border"></div>
             {isConnected && <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-64 h-64 border theme-border opacity-20 rounded-full"></div>}
        </div>

        {/* Top Bar with Menu & Indicators */}
        <div className="absolute top-6 left-6 z-20 flex space-x-2">
            {/* Sidebar Toggle */}
            <button 
                onClick={() => setIsSidebarOpen(true)}
                className="bg-black/80 border theme-border p-2 flex items-center justify-center backdrop-blur-sm theme-text hover:theme-bg-dim transition-colors"
                title="MENU"
            >
                <Bars3Icon className="w-5 h-5" />
            </button>

            {/* Status Indicators */}
            {isConnected && (
                <div className="bg-red-900/20 border border-red-500 px-3 py-1 flex items-center">
                     <div className="w-2 h-2 bg-red-500 rounded-full animate-ping mr-2"></div>
                     <span className="text-red-500 text-xs font-bold uppercase tracking-wider">LIVE</span>
                </div>
            )}
             {isScreenSharing && (
                <div className="bg-blue-900/20 border border-blue-500 px-3 py-1 flex items-center">
                     <span className="text-blue-500 text-xs font-bold uppercase tracking-wider">SCREEN</span>
                </div>
            )}
        </div>

        {/* Profile Button (Top Right) */}
        <div className="absolute top-6 right-6 z-20">
            <button 
                onClick={() => setIsSidebarOpen(true)}
                className={`border p-2 flex items-center justify-center transition-all hover:theme-shadow ${isConnected ? 'bg-black/50 theme-border theme-text' : 'bg-black theme-border theme-text'}`}
                title="USER_PROFILE"
            >
                {userName ? (
                   <span className="w-4 h-4 font-bold text-xs flex items-center justify-center">{userName.charAt(0).toUpperCase()}</span>
                ) : (
                   <UserIcon className="w-4 h-4" />
                )}
            </button>
        </div>

        {/* Video Element */}
        <video 
            ref={videoRef}
            autoPlay 
            playsInline 
            muted 
            style={{ filter: activeFilter }}
            className={`w-full h-full transition-all duration-300 ${isVideoEnabled ? 'opacity-100' : 'opacity-0'} ${isScreenSharing ? 'object-contain' : 'object-cover transform scale-x-[-1]'}`}
        />
          
        {/* Fallback for disabled video */}
        {!isVideoEnabled && (
            <div className={`absolute inset-0 flex items-center justify-center bg-black ${showGrid ? 'bg-grid' : ''}`}>
                <div className="w-24 h-24 border-2 theme-border flex items-center justify-center relative">
                    <span className="text-xl font-bold theme-text animate-pulse">NO_SIGNAL</span>
                    <div className="absolute inset-0 theme-bg opacity-10"></div>
                </div>
            </div>
        )}

        {/* Hidden Canvas for Frame Capture */}
        <canvas ref={canvasRef} className="hidden" />

      </div>

      {/* Sidebar Navigation */}
      {isSidebarOpen && (
          <div className="fixed inset-0 z-[100] flex">
              {/* Overlay to close */}
              <div 
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={() => setIsSidebarOpen(false)}
              ></div>
              
              {/* Sidebar Content */}
              <div className="relative w-80 h-full bg-black border-r theme-border theme-shadow flex flex-col p-6 animate-in slide-in-from-left duration-300">
                  <div className="flex items-center justify-between mb-8">
                      <h2 className="text-xl font-bold theme-text tracking-widest flex items-center">
                          <CogIcon className="w-6 h-6 mr-2" />
                          SETTINGS
                      </h2>
                      <button onClick={() => setIsSidebarOpen(false)} className="theme-text hover:opacity-70">
                          <XMarkIcon className="w-6 h-6" />
                      </button>
                  </div>

                  {/* Profile Section */}
                  <div className="mb-8 p-4 border theme-border theme-bg-dim bg-opacity-10 rounded">
                      <div className="flex items-center mb-4">
                        <div className="w-12 h-12 theme-bg rounded-full flex items-center justify-center text-black font-bold text-xl mr-3">
                            {userName ? userName.charAt(0).toUpperCase() : <UserIcon className="w-6 h-6" />}
                        </div>
                        <div>
                            <p className="theme-text font-bold">{userName || 'OPERATOR'}</p>
                            <p className="theme-text opacity-50 text-xs">{storedPhone}</p>
                        </div>
                      </div>
                      <form onSubmit={handleSaveProfile} className="space-y-3">
                          <input 
                            value={userName} 
                            onChange={e => setUserName(e.target.value)}
                            className="w-full bg-black border-b theme-border py-1 theme-text text-sm focus:outline-none placeholder-opacity-30"
                            placeholder="SET_ALIAS..."
                          />
                          <button type="submit" className="w-full theme-bg text-black font-bold text-xs py-2 uppercase tracking-wide hover:brightness-110">
                              UPDATE_ID
                          </button>
                      </form>
                  </div>

                  {/* Appearance Section */}
                  <div className="mb-8">
                      <h3 className="text-xs theme-text opacity-70 uppercase tracking-widest mb-4 flex items-center">
                          <PaletteIcon className="w-4 h-4 mr-2" />
                          APPEARANCE
                      </h3>
                      
                      {/* Theme Colors */}
                      <div className="grid grid-cols-5 gap-2 mb-6">
                          {THEMES.map((theme, idx) => (
                              <button
                                key={theme.name}
                                onClick={() => setThemeIndex(idx)}
                                className={`w-10 h-10 rounded-full border-2 transition-all ${themeIndex === idx ? 'border-white scale-110 shadow-[0_0_10px_white]' : 'border-transparent opacity-70 hover:opacity-100 hover:scale-105'}`}
                                style={{ backgroundColor: theme.color, boxShadow: themeIndex === idx ? `0 0 15px ${theme.color}` : 'none' }}
                                title={theme.name}
                              ></button>
                          ))}
                      </div>

                      {/* Toggles */}
                      <div className="space-y-3">
                        <label className="flex items-center justify-between cursor-pointer group">
                            <span className="theme-text text-sm font-mono group-hover:text-white transition-colors">HACKER_GRID</span>
                            <div className={`w-10 h-5 rounded-full relative transition-colors ${showGrid ? 'theme-bg' : 'bg-gray-800'}`} onClick={() => setShowGrid(!showGrid)}>
                                <div className={`absolute top-1 w-3 h-3 rounded-full bg-black transition-all ${showGrid ? 'right-1' : 'left-1'}`}></div>
                            </div>
                        </label>
                        <label className="flex items-center justify-between cursor-pointer group">
                            <span className="theme-text text-sm font-mono group-hover:text-white transition-colors">SCANLINES</span>
                            <div className={`w-10 h-5 rounded-full relative transition-colors ${showScanlines ? 'theme-bg' : 'bg-gray-800'}`} onClick={() => setShowScanlines(!showScanlines)}>
                                <div className={`absolute top-1 w-3 h-3 rounded-full bg-black transition-all ${showScanlines ? 'right-1' : 'left-1'}`}></div>
                            </div>
                        </label>
                      </div>
                  </div>

                   {/* Video Settings */}
                   <div className="mb-8">
                      <h3 className="text-xs theme-text opacity-70 uppercase tracking-widest mb-4 flex items-center">
                          <SettingsIcon className="w-4 h-4 mr-2" />
                          VIDEO_CONFIG
                      </h3>
                      <select 
                        value={videoQuality}
                        onChange={handleQualityChange}
                        className="w-full bg-black border theme-border theme-text text-sm py-2 px-3 focus:outline-none"
                        disabled={isConnected} 
                      >
                        <option value={VideoQuality.SD}>STANDARD (480p)</option>
                        <option value={VideoQuality.HD}>HIGH_DEF (720p)</option>
                        <option value={VideoQuality.UHD}>ULTRA_HD (2160p)</option>
                      </select>
                      {isConnected && <p className="text-red-500 text-[10px] mt-1">* Cannot change quality while live</p>}
                   </div>

                  <div className="mt-auto">
                    <button onClick={handleLogout} className="w-full flex items-center justify-center text-red-500 hover:bg-red-900/20 py-3 border border-red-900/50 hover:border-red-500 transition-colors uppercase font-bold tracking-wider text-sm">
                        <ArrowRightOnRectangleIcon className="w-4 h-4 mr-2" />
                        TERMINATE
                    </button>
                  </div>
              </div>
          </div>
      )}
      
      {/* Controls Section */}
      <div className={controlsClass + (isConnected ? " z-50 pointer-events-auto" : "")}>
            
            {/* Filter Menu (Conditional) */}
            {showFilters && !isScreenSharing && (
                <div className="flex space-x-2 overflow-x-auto max-w-full pb-2 px-2 scrollbar-hide">
                    {FILTERS.map((filter) => (
                        <button
                            key={filter.name}
                            onClick={() => setActiveFilter(filter.value)}
                            className={`px-4 py-2 border text-xs font-bold font-mono transition-all uppercase ${
                                activeFilter === filter.value 
                                ? 'theme-bg text-black theme-border' 
                                : 'bg-black theme-text theme-border hover:theme-bg-dim'
                            }`}
                        >
                            {filter.name}
                        </button>
                    ))}
                </div>
            )}

            {/* Main Controls Row */}
            <div className="flex items-center justify-center space-x-6">
                <button 
                    onClick={() => setIsVideoEnabled(!isVideoEnabled)}
                    className={`p-4 border transition-all duration-200 ${isVideoEnabled ? 'bg-black theme-border theme-text hover:theme-shadow' : 'bg-red-900/20 border-red-500 text-red-500 hover:bg-red-900/40'}`}
                >
                    {isVideoEnabled ? <VideoIcon className="w-6 h-6" /> : <VideoSlashIcon className="w-6 h-6" />}
                </button>

                <button 
                    onClick={handleToggleCall}
                    className={`p-5 border-2 transform transition-all duration-200 hover:scale-105 ${
                        connectionState === ConnectionState.CONNECTED 
                        ? 'bg-red-600 border-red-600 text-black shadow-[0_0_20px_red]' 
                        : connectionState === ConnectionState.CONNECTING
                        ? 'bg-yellow-500 border-yellow-500 text-black animate-pulse'
                        : 'theme-bg theme-border text-black theme-shadow'
                    }`}
                >
                    {connectionState === ConnectionState.CONNECTED ? (
                        <PhoneXMarkIcon className="w-8 h-8" />
                    ) : (
                        <PhoneIcon className="w-8 h-8" />
                    )}
                </button>
                
                <button 
                    onClick={toggleScreenShare}
                    className={`p-4 border transition-all duration-200 ${
                        isScreenSharing
                        ? 'theme-bg text-black theme-border theme-shadow' 
                        : 'bg-black theme-text theme-border hover:theme-bg-dim'
                    }`}
                    title={isScreenSharing ? "STOP_SHARING" : "SHARE_SCREEN"}
                >
                    {isScreenSharing ? <StopScreenShareIcon className="w-6 h-6" /> : <ScreenShareIcon className="w-6 h-6" />}
                </button>

                <button 
                    onClick={() => !isScreenSharing && setShowFilters(!showFilters)}
                    className={`p-4 border theme-border transition-all duration-200 ${
                        (showFilters || activeFilter !== 'none') && !isScreenSharing
                        ? 'theme-bg-dim theme-text theme-shadow' 
                        : 'bg-black theme-text hover:theme-bg-dim'
                    } ${isScreenSharing ? 'opacity-50 cursor-not-allowed' : ''}`}
                    disabled={isScreenSharing}
                >
                    <SparklesIcon className="w-6 h-6" />
                </button>

                 <button 
                    onClick={handleTogglePiP}
                    className={`p-4 border theme-border bg-black hover:theme-bg-dim theme-text transition-all`}
                    title="Minimize"
                >
                    <PipIcon className="w-6 h-6" />
                </button>
            </div>
      </div>

      {/* Error Message */}
      {errorMsg && (
            <div className={`mt-4 p-2 bg-red-900/80 border border-red-500 text-red-200 text-xs font-mono uppercase tracking-wide ${isConnected ? 'fixed top-24 z-50' : ''}`}>
                >> ALERT: {errorMsg}
            </div>
      )}

      {!isConnected && (
        <div className="mt-8 text-center theme-text opacity-40 text-[10px] font-mono tracking-[0.2em] relative z-10">
           <p>SYSTEM_VERSION 2.0.5 | SECURE_CHANNEL</p>
           <p className="mt-1">POWERED_BY_GEMINI_NEURAL_NET</p>
        </div>
      )}
    </div>
  );
};

export default App;