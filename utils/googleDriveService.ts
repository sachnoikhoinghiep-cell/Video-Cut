import { DriveFolder, GoogleDriveConfig } from '../types';

declare global {
  interface Window {
    google: any;
    gapi: any;
  }
}

class GoogleDriveService {
  private tokenClient: any;
  private accessToken: string | null = null;
  private config: GoogleDriveConfig | null = null;
  private isGapiLoaded = false;
  private isGisLoaded = false;

  public setConfig(config: GoogleDriveConfig) {
    this.config = config;
  }

  // Khởi tạo các thư viện Google
  public async init(): Promise<void> {
    return new Promise((resolve) => {
      const checkScripts = setInterval(() => {
        if (window.google && window.gapi) {
          clearInterval(checkScripts);
          this.loadLibs(resolve);
        }
      }, 100);
    });
  }

  private loadLibs(callback: () => void) {
    if (!this.config) return;

    // Load GAPI (Client)
    window.gapi.load('client:picker', async () => {
      await window.gapi.client.init({
        apiKey: this.config!.apiKey,
        discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
      });
      this.isGapiLoaded = true;
      if (this.isGisLoaded) callback();
    });

    // Load GIS (Identity)
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: this.config!.clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (response: any) => {
        if (response.error !== undefined) {
          throw response;
        }
        this.accessToken = response.access_token;
      },
    });
    this.isGisLoaded = true;
    if (this.isGapiLoaded) callback();
  }

  // Đăng nhập và lấy Token
  public async authenticate(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.tokenClient) return reject("Google Service chưa khởi tạo");
      
      // Override callback để capture token cho lần gọi này
      this.tokenClient.callback = (resp: any) => {
        if (resp.error) reject(resp);
        this.accessToken = resp.access_token;
        resolve(this.accessToken!);
      };

      // Yêu cầu quyền truy cập (nếu chưa có hoặc hết hạn)
      if (window.gapi.client.getToken() === null) {
        this.tokenClient.requestAccessToken({ prompt: 'consent' });
      } else {
        this.tokenClient.requestAccessToken({ prompt: '' });
      }
    });
  }

  // Mở Google Picker để chọn thư mục
  public async pickFolder(): Promise<DriveFolder> {
    if (!this.accessToken) await this.authenticate();

    return new Promise((resolve, reject) => {
      const showPicker = () => {
        const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
          .setSelectFolderEnabled(true)
          .setMimeTypes('application/vnd.google-apps.folder');

        const picker = new window.google.picker.PickerBuilder()
          .setDeveloperKey(this.config!.apiKey)
          .setAppId(this.config!.appId || '')
          .setOAuthToken(this.accessToken)
          .addView(view)
          .setCallback((data: any) => {
            if (data.action === window.google.picker.Action.PICKED) {
              const doc = data.docs[0];
              resolve({
                id: doc.id,
                name: doc.name
              });
            } else if (data.action === window.google.picker.Action.CANCEL) {
              reject(new Error("Đã hủy chọn thư mục"));
            }
          })
          .build();
        picker.setVisible(true);
      };
      showPicker();
    });
  }

  // Upload file lên Drive (Multipart upload)
  public async uploadFile(blob: Blob, filename: string, folderId: string): Promise<any> {
    if (!this.accessToken) throw new Error("Chưa đăng nhập Google Drive");

    const metadata = {
      name: filename,
      parents: [folderId]
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + this.accessToken
      },
      body: form
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`Upload lỗi: ${err.error?.message || response.statusText}`);
    }

    return await response.json();
  }
}

export const googleDriveService = new GoogleDriveService();