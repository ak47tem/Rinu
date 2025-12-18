import React, { useEffect, useState } from 'react';
import { AudioVisualizerProps } from '../types';

export const Visualizer: React.FC<AudioVisualizerProps> = ({ isPlaying }) => {
  const [bars, setBars] = useState<number[]>(new Array(5).fill(10));

  useEffect(() => {
    let animationId: number;
    const animate = () => {
      if (isPlaying) {
        setBars(prev => prev.map(() => Math.random() * 20 + 10)); // Simulate activity
      } else {
        setBars(new Array(5).fill(5)); // Idle state
      }
      animationId = requestAnimationFrame(animate);
    };
    
    // Slow down the update rate slightly for better visual effect
    const interval = setInterval(animate, 100);

    return () => {
      cancelAnimationFrame(animationId);
      clearInterval(interval);
    };
  }, [isPlaying]);

  return (
    <div className="flex items-center justify-center space-x-1 h-8">
      {bars.map((height, i) => (
        <div
          key={i}
          className="w-1.5 transition-all duration-100 ease-in-out theme-bg theme-shadow"
          style={{ height: `${height}px` }}
        />
      ))}
    </div>
  );
};