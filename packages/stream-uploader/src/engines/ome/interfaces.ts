export interface AppStream {
  app: string;
  stream: string;
}

export interface PlaylistEntry {
  seq: number;
  duration: number;
  uri: string;
}

export interface OmeEngineOptions {
  admissionSecret?: string;
  failOpen?: boolean;
}

export interface OmeAdmissionRequest {
  direction: 'incoming' | 'outgoing';
  protocol: string;
  url: string;
  time?: string;
  new_url?: string;
  status?: 'opening' | 'closing';
}

export interface OmeAdmissionPayload {
  client?: { address?: string; port?: number };
  request: OmeAdmissionRequest;
}

export interface OmeAdmissionReply {
  allowed: boolean;
  new_url?: string | null;
  lifetime?: number;
  reason?: string;
}
