// Định nghĩa các chế độ xử lý video
export enum ProcessingMode {
  EXTRACT_FRAMES = 'EXTRACT_FRAMES',
  CUT_SEGMENTS = 'CUT_SEGMENTS',
}

// Trạng thái của ứng dụng
export enum AppStatus {
  IDLE = 'IDLE',       // Chưa làm gì
  LOADING_CORE = 'LOADING_CORE', // Đang tải thư viện FFmpeg
  PROCESSING = 'PROCESSING', // Đang xử lý video
  COMPLETED = 'COMPLETED',   // Hoàn thành
  ERROR = 'ERROR',     // Có lỗi xảy ra
}

// Interface cho FileSystemDirectoryHandle (API truy cập thư mục)
// Vì TypeScript mặc định có thể chưa bao gồm type này tùy môi trường
export interface FileSystemDirectoryHandle {
  kind: 'directory';
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
}

export interface FileSystemFileHandle {
  kind: 'file';
  name: string;
  createWritable(): Promise<FileSystemWritableFileStream>;
}

export interface FileSystemWritableFileStream extends WritableStream {
  write(data: any): Promise<void>;
  close(): Promise<void>;
}

export interface LogMessage {
  id: string;
  text: string;
  timestamp: Date;
  type: 'info' | 'error' | 'success' | 'warning';
}