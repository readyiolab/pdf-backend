export interface CloudIntegration {
  id: string;
  userId: string;
  provider: 'gdrive' | 'dropbox' | 'onedrive' | 'box';
  accountEmail: string;
  accessToken: string;
  refreshToken?: string | null;
  autoSync: boolean;
  lastSyncAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectCloudDto {
  provider: 'gdrive' | 'dropbox' | 'onedrive' | 'box';
  accountEmail: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface CloudFileItem {
  id: string;
  name: string;
  size: string;
  updatedAt: string;
  providerId: 'gdrive' | 'dropbox' | 'onedrive' | 'box';
  providerName: string;
  type: 'pdf' | 'docx' | 'xlsx';
  downloadUrl?: string;
}
