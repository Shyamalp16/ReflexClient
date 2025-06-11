import { useEffect, useRef, useState, useCallback } from 'react';
import styles from './StreamingClient.module.css';

interface PerformanceData {
  fps: number;
  latency: number;
  quality: string;
  bitrate: string;
}

interface SignalingMessage {
  type: string;
  sdp?: string;
  candidate?: RTCIceCandidate;
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface StreamingClientProps {
  onToggleFullscreen: () => Promise<void>;
  isFullscreen: boolean;
  onBack: () => void;
}

export default function StreamingClient({ onToggleFullscreen, isFullscreen, onBack }: StreamingClientProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const mouseChannelRef = useRef<RTCDataChannel | null>(null);
  const debugLogRef = useRef<HTMLDivElement>(null);
  const [isDebugVisible, setIsDebugVisible] = useState(false);
  const [isPerfVisible, setIsPerfVisible] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [statusText, setStatusText] = useState('Connecting...');
  const [performanceData, setPerformanceData] = useState<PerformanceData>({
    fps: 0,
    latency: 0,
    quality: '--',
    bitrate: '-- kbps'
  });

  const keyState = useRef(new Set<string>());
  const mouseButtonState = useRef(new Set<number>());
  const mousePosition = useRef({ x: 0, y: 0 });
  const frameCount = useRef(0);
  const lastFrameTime = useRef(Date.now());
  const animationId = useRef<number>();
  const connectionAttempted = useRef(false);

  const serverUrl = "ws://localhost:3000";
//   const serverUrl = "ws://10.0.0.134:3000";

  const log = useCallback((message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    console.log(`[${level.toUpperCase()}] ${message}`);
  }, []);

  useEffect(() => {
    log('Initializing WebRTC client...', 'info');
    
    // Initialize canvas size
    if (canvasRef.current) {
      canvasRef.current.width = 1920;
      canvasRef.current.height = 1080;
    }

    // Add keyboard event listeners
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Start connection
    connectToSignalingServer();

    return () => {
      // Only remove event listeners on unmount, don't close connections
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []); // Empty dependency array to run only once

  const connectToSignalingServer = () => {
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      log('Connection already in progress', 'info');
      return;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      log('Closing existing connection', 'info');
      wsRef.current.close();
    }

    log('Attempting to connect to WebSocket server...', 'info');
    
    try {
      wsRef.current = new WebSocket(serverUrl);

      wsRef.current.onopen = () => {
        log('WebSocket connection established', 'info');
        setConnectionStatus('connecting');
        initializePeerConnection();
      };

      wsRef.current.onclose = (event) => {
        log(`WebSocket connection closed: ${event.code} - ${event.reason || 'No reason provided'}`, 'warn');
        setConnectionStatus('disconnected');
        
        // Only attempt reconnect if not intentionally closed
        if (event.code !== 1000) {
          setTimeout(() => {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
              connectToSignalingServer();
            }
          }, 2000);
        }
      };

      wsRef.current.onerror = (error) => {
        log(`WebSocket error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
        setConnectionStatus('disconnected');
      };

      wsRef.current.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleSignalingMessage(message);
        } catch (err) {
          log(`Failed to parse WebSocket message: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
        }
      };
    } catch (err) {
      log(`Failed to create WebSocket: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      setTimeout(connectToSignalingServer, 2000);
    }
  };

  const initializePeerConnection = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    log('Initializing peer connection...', 'info');
    
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    try {
      peerConnectionRef.current = new RTCPeerConnection(configuration);

      // Set up data channel for mouse events
      const mouseChannel = peerConnectionRef.current.createDataChannel('mouse', {
        ordered: true,
        maxRetransmits: 0
      });
      mouseChannelRef.current = mouseChannel;

      mouseChannel.onopen = () => {
        log('Mouse channel opened', 'info');
      };

      mouseChannel.onclose = () => {
        log('Mouse channel closed', 'warn');
      };

      mouseChannel.onerror = (error) => {
        log(`Mouse channel error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
      };

      // Set up event handlers first
      peerConnectionRef.current.onicecandidate = handleIceCandidate;
      peerConnectionRef.current.oniceconnectionstatechange = handleIceConnectionStateChange;
      peerConnectionRef.current.ontrack = (event: RTCTrackEvent) => {
        handleTrack(event);
        renderVideoToCanvas();
      };

      peerConnectionRef.current.onconnectionstatechange = () => {
        if (!peerConnectionRef.current) return;
        
        const state = peerConnectionRef.current.connectionState;
        log(`Connection state changed to: ${state}`, 'info');
        
        switch (state) {
          case 'connected':
            setConnectionStatus('connected');
            break;
          case 'disconnected':
          case 'failed':
            setConnectionStatus('disconnected');
            // Attempt to reconnect
            setTimeout(() => {
              if (wsRef.current?.readyState !== WebSocket.OPEN) {
                connectToSignalingServer();
              }
            }, 2000);
            break;
        }
      };

      // Then create and send offer
      const sendOffer = async () => {
        if (!peerConnectionRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          log('Cannot send offer - connection not ready', 'error');
          return;
        }

        try {
          const offer = await peerConnectionRef.current.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: false
          });

          await peerConnectionRef.current.setLocalDescription(offer);
          
          if (wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'offer',
              sdp: offer.sdp
            }));
            log('Offer sent successfully', 'info');
          } else {
            log('WebSocket closed before sending offer', 'error');
            connectToSignalingServer();
          }
        } catch (err) {
          log(`Failed to create or send offer: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
          connectToSignalingServer();
        }
      };

      // Wait a short moment before sending the offer to ensure WebSocket is ready
      setTimeout(sendOffer, 100);

    } catch (err) {
      log(`Failed to initialize peer connection: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      connectToSignalingServer();
    }
  };

  const handleOffer = async (sdp: string | undefined) => {
    if (!sdp || !peerConnectionRef.current) {
      log('Invalid offer received', 'error');
      return;
    }
    try {
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'answer',
          sdp: answer.sdp
        }));
      }
    } catch (err) {
      log(`Error handling offer: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  const handleAnswer = async (sdp: string | undefined) => {
    if (!sdp || !peerConnectionRef.current) {
      log('Invalid answer received', 'error');
      return;
    }
    try {
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    } catch (err) {
      log(`Error handling answer: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  const handleCandidate = async (candidate: RTCIceCandidateInit) => {
    if (!peerConnectionRef.current) {
      log('No peer connection available', 'error');
      return;
    }
    try {
      await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      log(`Error handling ICE candidate: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  const handleIceCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
      log('Sending ICE candidate', 'info');
      wsRef.current.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate
      }));
    }
  };

  const handleIceConnectionStateChange = () => {
    if (peerConnectionRef.current) {
      const state = peerConnectionRef.current.iceConnectionState;
      log(`ICE connection state changed to: ${state}`, 'info');
      
      switch (state) {
        case 'connected':
          setConnectionStatus('connected');
          break;
        case 'disconnected':
        case 'failed':
          setConnectionStatus('disconnected');
          break;
        case 'checking':
          setConnectionStatus('connecting');
          break;
      }
    }
  };

  const handleTrack = (event: RTCTrackEvent) => {
    log('Received remote track', 'info');
    if (videoRef.current && event.streams[0]) {
      videoRef.current.srcObject = event.streams[0];
      videoRef.current.play().catch(err => {
        log(`Failed to play video: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      });
    }
  };

  const renderVideoToCanvas = () => {
    if (!canvasRef.current || !videoRef.current) return;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const render = () => {
      if (videoRef.current?.videoWidth) {
        ctx.drawImage(
          videoRef.current,
          0, 0,
          videoRef.current.videoWidth,
          videoRef.current.videoHeight,
          0, 0,
          canvasRef.current!.width,
          canvasRef.current!.height
        );
      }
      animationId.current = requestAnimationFrame(render);
    };

    render();
  };

  const handleSignalingMessage = (message: SignalingMessage) => {
    if (!peerConnectionRef.current) {
      log('No peer connection available', 'error');
      return;
    }

    switch (message.type) {
      case 'offer':
        log('Received offer', 'info');
        handleOffer(message.sdp);
        break;
      case 'answer':
        log('Received answer', 'info');
        handleAnswer(message.sdp);
        break;
      case 'candidate':
        log('Received ICE candidate', 'info');
        if (message.candidate) {
          handleCandidate(message.candidate);
        }
        break;
      default:
        log('Unknown message type', 'warn');
    }
  };

  const handleBack = () => {
    log('Cleaning up WebRTC client...', 'info');
    
    // Close WebSocket connection
    if (wsRef.current) {
      wsRef.current.close(1000, "User initiated disconnect");
      wsRef.current = null;
    }
    
    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // Close mouse channel
    if (mouseChannelRef.current) {
      mouseChannelRef.current.close();
      mouseChannelRef.current = null;
    }

    // Call the onBack callback
    onBack();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!event.code || event.repeat) return;
    
    // Handle escape key for fullscreen
    if (event.key === 'Escape' && isFullscreen) {
      onToggleFullscreen();
      return;
    }
    
    event.preventDefault();
    const keyData = { key: event.key, code: event.code, type: 'keydown', timestamp: Date.now() };
    if (mouseChannelRef.current?.readyState === 'open') {
      mouseChannelRef.current.send(JSON.stringify(keyData));
    }
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (!event.code) return;
    
    event.preventDefault();
    const keyData = { key: event.key, code: event.code, type: 'keyup', timestamp: Date.now() };
    if (mouseChannelRef.current?.readyState === 'open') {
      mouseChannelRef.current.send(JSON.stringify(keyData));
    }
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return;
    event.preventDefault();
    
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    
    const mouseData = {
      type: 'mousemove',
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
      timestamp: Date.now(),
    };

    if (mouseChannelRef.current?.readyState === 'open') {
      mouseChannelRef.current.send(JSON.stringify(mouseData));
    }
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return;
    event.preventDefault();
    
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    
    const mouseData = {
      type: 'mousedown',
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
      button: event.button,
      timestamp: Date.now(),
    };

    if (mouseChannelRef.current?.readyState === 'open') {
      mouseChannelRef.current.send(JSON.stringify(mouseData));
    }
  };

  const handleMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return;
    event.preventDefault();
    
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    
    const mouseData = {
      type: 'mouseup',
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
      button: event.button,
      timestamp: Date.now(),
    };

    if (mouseChannelRef.current?.readyState === 'open') {
      mouseChannelRef.current.send(JSON.stringify(mouseData));
    }
  };

  return (
    <div className={styles.streamingClient}>
      {/* Connection Status */}
      <div className={styles.connectionIndicator}>
        <div className={`${styles.statusDot} ${styles[connectionStatus]}`} />
        <span className={styles.statusText}>Connection Status</span>
      </div>

      {/* Control Buttons */}
      <div className={styles.controls}>
        <button 
          className={styles.controlButton} 
          onClick={handleBack} 
          title="Back to Home"
        >
          ←
        </button>
        <button 
          className={styles.controlButton} 
          onClick={onToggleFullscreen} 
          title="Toggle Fullscreen"
        >
          {isFullscreen ? '🗗' : '⛶'}
        </button>
      </div>

      {/* Game Canvas */}
      <canvas ref={canvasRef} className={styles.gameCanvas} />
      <div 
        className={styles.inputOverlay} 
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Hidden Video Element */}
      <video
        ref={videoRef}
        className={styles.hiddenVideo}
        autoPlay
        playsInline
        muted
      />
    </div>
  );
} 