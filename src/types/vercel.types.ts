export interface VercelEnvMetadata {
  createdAt?: string;
  target: "production" | "preview" | "development";
  updatedAt?: string;
}

export interface VercelEnvPullResult {
  metadata: Record<string, VercelEnvMetadata>;
  variables: Record<string, string>;
}

export interface VercelSyncResult {
  added: number;
  addedKeys: string[];
  failed: string[];
  skipped: number;
  skippedKeys: string[];
  updated: number;
  updatedKeys: string[];
}

export interface VercelProjectEnvsResponse {
  envs: VercelEnvResponse[];
}

export interface VercelEnvResponse {
  comment?: string;
  configurationId?: string;
  createdAt: number;
  createdBy: string;
  customEnvironmentIds?: string[];
  decrypted: boolean;
  id: string;
  internalContentHint?: InternalContentHint;
  key: string;
  lastEditedByDisplayName: string;
  target: string[];
  type: string;
  updatedAt: number;
  updatedBy?: string;
  value: string;
}

export interface InternalContentHint {
  encryptedValue: string;
  type: string;
}
