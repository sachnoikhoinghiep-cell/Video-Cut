import { FileSystemDirectoryHandle, AppStatus } from '../types';

// Declare globals for the UMD libraries loaded in index.html
declare global {
  interface Window {
    FFmpeg: any;
    FFmpegUtil: any;
  }
}

/**
 * Service quản lý FFmpeg và xử lý file
 * Sử dụng Singleton pattern để đảm bảo chỉ có 1 instance FFmpeg chạy
 */
class FFmpegService {
  private ffmpeg: any = null; // Use any to avoid type import dependency
  private isLoaded: boolean = false;

  // Khởi tạo FFmpeg engine
  public async load() {
    if (this.isLoaded && this.ffmpeg) return this.ffmpeg;

    if (!window.FFmpeg) {
      throw new Error("Thư viện FFmpeg chưa tải xong. Vui lòng refresh trang.");
    }

    this.ffmpeg = new window.FFmpeg.FFmpeg();

    // Bắt sự kiện log để debug
    this.ffmpeg.on('log', ({ message }: { message: string }) => {
      console.log('FFmpeg Log:', message);
    });

    // Sử dụng phiên bản core tương thích với UMD build (0.12.6 là bản ổn định cho 0.12.x)
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    
    try {
        // Load WASM files từ CDN
        // Sử dụng toBlobURL từ window.FFmpegUtil
        const toBlobURL = window.FFmpegUtil.toBlobURL;
        
        await this.ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });

        this.isLoaded = true;
        return this.ffmpeg;
    } catch (e) {
        console.error("FFmpeg load error:", e);
        throw new Error("Không thể tải thư viện xử lý video. Vui lòng thử lại hoặc kiểm tra kết nối mạng.");
    }
  }

  // Ghi file blob vào thư mục người dùng chọn
  // Cần quyền truy cập File System Access API
  public async saveToDirectory(
    dirHandle: FileSystemDirectoryHandle, 
    filename: string, 
    data: Blob | Uint8Array
  ) {
    try {
      // Tạo file handle mới hoặc ghi đè file cũ
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      // Tạo luồng ghi
      const writable = await fileHandle.createWritable();
      // Ghi dữ liệu
      await writable.write(data);
      // Đóng file
      await writable.close();
    } catch (error) {
      console.error('Lỗi khi ghi file:', error);
      throw new Error(`Không thể lưu file ${filename}. Vui lòng kiểm tra quyền truy cập.`);
    }
  }

  // Xử lý cắt video
  public async cutVideo(
    file: File, 
    segmentTime: number, 
    outputDir: FileSystemDirectoryHandle | null, // Cho phép null cho chế độ fallback
    onProgress: (progress: number) => void,
    onLog: (msg: string) => void,
    onFileGenerated?: (blob: Blob, filename: string) => void // Callback cho fallback
  ) {
    if (!this.ffmpeg) throw new Error("FFmpeg chưa được khởi tạo");
    
    const fetchFile = window.FFmpegUtil.fetchFile;
    const inputFileName = 'input.mp4';
    
    // Ghi file input vào bộ nhớ ảo của FFmpeg (MEMFS)
    onLog("Đang nạp file vào bộ nhớ...");
    await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));

    // Lệnh cắt video
    onLog("Đang thực hiện cắt video...");
    
    this.ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      onProgress(Math.round(progress * 100));
    });

    await this.ffmpeg.exec([
      '-i', inputFileName,
      '-c', 'copy',
      '-map', '0',
      '-segment_time', segmentTime.toString(),
      '-f', 'segment',
      '-reset_timestamps', '1',
      'output_%03d.mp4'
    ]);

    // Đọc các file output từ MEMFS
    onLog("Đang xuất các đoạn clip...");
    const files = await this.ffmpeg.listDir('.');
    
    let count = 0;
    for (const f of files) {
      // @ts-ignore
      if (!f.isDir && f.name.startsWith('output_') && f.name.endsWith('.mp4')) {
        // @ts-ignore
        const data = await this.ffmpeg.readFile(f.name);
        const blob = new Blob([data], { type: 'video/mp4' });

        if (outputDir) {
            await this.saveToDirectory(outputDir, f.name, blob);
        } else if (onFileGenerated) {
            onFileGenerated(blob, f.name);
        }

        // @ts-ignore
        await this.ffmpeg.deleteFile(f.name);
        count++;
      }
    }
    
    await this.ffmpeg.deleteFile(inputFileName);
    onLog(`Hoàn thành! Đã xử lý ${count} clip.`);
  }

  // Xử lý trích xuất frames
  public async extractFrames(
    file: File,
    outputDir: FileSystemDirectoryHandle | null,
    onProgress: (progress: number) => void,
    onLog: (msg: string) => void,
    onFileGenerated?: (blob: Blob, filename: string) => void
  ) {
    if (!this.ffmpeg) throw new Error("FFmpeg chưa được khởi tạo");

    const fetchFile = window.FFmpegUtil.fetchFile;
    const inputFileName = 'input.mp4';
    
    onLog("Đang nạp video...");
    await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));

    onLog("Bắt đầu trích xuất frame...");
    
    this.ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      onProgress(Math.round(progress * 100));
    });

    await this.ffmpeg.exec([
      '-i', inputFileName,
      '-vf', 'fps=1',
      'frame_%04d.png'
    ]);

    onLog("Đang xuất hình ảnh...");
    const files = await this.ffmpeg.listDir('.');
    
    let count = 0;
    for (const f of files) {
      // @ts-ignore
      if (!f.isDir && f.name.startsWith('frame_') && f.name.endsWith('.png')) {
        // @ts-ignore
        const data = await this.ffmpeg.readFile(f.name);
        const blob = new Blob([data], { type: 'image/png' });

        if (outputDir) {
            await this.saveToDirectory(outputDir, f.name, blob);
        } else if (onFileGenerated) {
            onFileGenerated(blob, f.name);
        }

        // @ts-ignore
        await this.ffmpeg.deleteFile(f.name);
        count++;
      }
    }

    await this.ffmpeg.deleteFile(inputFileName);
    onLog(`Hoàn thành! Đã xử lý ${count} ảnh.`);
  }
}

export const ffmpegService = new FFmpegService();