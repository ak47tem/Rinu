export enum VideoQuality {
  SD = 'SD (480p)',
  HD = 'HD (720p)',
  UHD = '4K (2160p)'
}

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error'
}

export interface AudioVisualizerProps {
  isPlaying: boolean;
}