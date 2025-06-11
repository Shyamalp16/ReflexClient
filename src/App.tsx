import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import StreamingClient from "./components/StreamingClient";
import { Window } from '@tauri-apps/api/window';

function App() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleKeyPress = async (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isStreaming && isFullscreen) {
        try {
          const currentWindow = Window.getCurrent();
          // Only exit fullscreen, never enter it with Escape
          await currentWindow.setFullscreen(false);
          await currentWindow.setDecorations(true);
          setIsFullscreen(false);
        } catch (err) {
          console.error("Failed to exit full-screen mode:", err);
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isStreaming, isFullscreen]);

  const handlePlay = async () => {
    try {
      const currentWindow = Window.getCurrent();
      
      // First make the window fullscreen
      await currentWindow.setFullscreen(true);
      await currentWindow.setDecorations(false);
      setIsFullscreen(true);
      
      // Then transition to the streaming view
      setIsStreaming(true);
    } catch (err) {
      console.error("Failed to enter full-screen mode:", err);
    }
  };

  const handleToggleFullscreen = async () => {
    try {
      const currentWindow = Window.getCurrent();
      const fullscreen = await currentWindow.isFullscreen();
      
      if (fullscreen) {
        await currentWindow.setFullscreen(false);
        await currentWindow.setDecorations(true);
      } else {
        await currentWindow.setFullscreen(true);
        await currentWindow.setDecorations(false);
      }
      setIsFullscreen(!fullscreen);
    } catch (err) {
      console.error("Failed to toggle full-screen mode:", err);
    }
  };

  const handleBack = async () => {
    try {
      const currentWindow = Window.getCurrent();
      // Exit fullscreen when going back to home
      await currentWindow.setFullscreen(false);
      await currentWindow.setDecorations(true);
      setIsFullscreen(false);
      setIsStreaming(false);
    } catch (err) {
      console.error("Failed to exit full-screen mode:", err);
    }
  };

  // If in streaming mode, show the StreamingClient
  if (isStreaming) {
    return (
      <StreamingClient 
        onToggleFullscreen={handleToggleFullscreen} 
        isFullscreen={isFullscreen}
        onBack={handleBack}
      />
    );
  }

  // Otherwise show the landing page
  return (
    <div className="min-h-screen bg-zinc-900 flex items-center justify-center">
      <div className="text-center space-y-8">
        <div className="space-y-3">
          <h1 className="text-5xl font-bold text-white tracking-tight">
            Reflex Gaming
          </h1>
          <p className="text-xl text-zinc-400">
            Your Remote Game Station
          </p>
        </div>
        
        <Button 
          className="text-2xl px-12 py-8 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-all duration-300 hover:scale-105 shadow-lg hover:shadow-zinc-800/50"
          onClick={handlePlay}
        >
          Play
        </Button>
      </div>
    </div>
  );
}

export default App;
