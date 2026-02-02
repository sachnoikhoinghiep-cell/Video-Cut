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

  /**
   * Helper để load script thủ công nếu CDN chính trong HTML bị lỗi
   */
  private loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Kiểm tra xem script đã tồn tại chưa để tránh load trùng
      if (document.querySelector(`script[src="${src}"]`)) {
          // Nếu đã có tag nhưng chưa chạy xong (biến global chưa có), 
          // ta vẫn resolve để chờ loop kiểm tra, hoặc có thể tạo tag mới nếu cần.
          // Ở đây ta cứ tạo tag mới để force reload.
      }
      
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.body.appendChild(script);
    });
  }

  private async waitForGlobal(timeoutMs = 30000): Promise<boolean> {
    const startTime = Date.now();
    let fallbackTriggered = false;

    while (Date.now() - startTime < timeoutMs) {
      if (window.FFmpeg && window.FFmpegUtil) {
        return true;
      }

      // Nếu sau 5 giây mà chưa thấy thư viện, kích hoạt fallback
      if (!fallbackTriggered && (Date.now() - startTime > 5000)) {
        console.warn("FFmpeg load chậm. Đang kích hoạt cơ chế fallback...");
        fallbackTriggered = true;
        
        // Chiến lược fallback:
        // 1. Thử load lại từ jsDelivr (có thể request trước đó bị timeout/lỗi)
        // 2. Nếu thất bại, thử load từ unpkg
        
        const runFallback = async () => {
            try {
                console.log("Fallback 1: Retrying jsDelivr...");
                await Promise.all([
                    this.loadScript('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js'),
                    this.loadScript('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/util.js')
                ]);
            } catch (err) {
                console.warn("Fallback 1 failed. Trying Fallback 2 (unpkg)...", err);
                try {
                    await Promise.all([
                        this.loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js'),
                        this.loadScript('https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/util.js')
                    ]);
                } catch (err2) {
                    console.error("All fallbacks failed:", err2);
                }
            }
        };
        
        // Chạy không await để loop tiếp tục kiểm tra window.FFmpeg
        runFallback();
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  // Khởi tạo FFmpeg engine
  public async load() {
    if (this.isLoaded && this.ffmpeg) return this.ffmpeg;

    const isReady = await this.waitForGlobal();
    if (!isReady) {
      throw new Error("Không thể tải thư viện xử lý video (Timeout). Vui lòng kiểm tra kết nối internet và tải lại trang.");
    }

    try {
      this.ffmpeg = new window.FFmpeg.FFmpeg();

      // Bắt sự kiện log để debug
      this.ffmpeg.on('log', ({ message }: { message: string }) => {
        console.log('FFmpeg Log:', message);
      });

      // Dùng jsDelivr cho core files để đồng bộ
      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
      
      // Load WASM files
      const toBlobURL = window.FFmpegUtil.toBlobURL;
      
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      this.isLoaded = true;
      return this.ffmpeg;
    } catch (e: any) {
        console.error("FFmpeg initialization error:", e);
        // Kiểm tra lỗi SharedArrayBuffer (thường do thiếu headers COOP/COEP)
        if (e.message && e.message.includes("SharedArrayBuffer")) {
           throw new Error("Trình duyệt chặn tính năng bảo mật. Vui lòng thử trình duyệt khác (Chrome/Edge mới nhất) hoặc kiểm tra HTTPS.");
        }
        throw new Error("Lỗi khởi động engine: " + (e.message || "Không xác định"));
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
    try {
        await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));
    } catch (e) {
        throw new Error("Lỗi khi nạp file. File có thể bị hỏng hoặc format không hỗ trợ.");
    }

    // Lệnh cắt video
    onLog("Đang thực hiện cắt video...");
    
    // Reset progress handler để tránh duplicate nếu chạy nhiều lần
    this.ffmpeg.off('progress');
    this.ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      onProgress(Math.round(progress * 100));
    });

    try {
        await this.ffmpeg.exec([
        '-i', inputFileName,
        '-c', 'copy',
        '-map', '0',
        '-segment_time', segmentTime.toString(),
        '-f', 'segment',
        '-reset_timestamps', '1',
        'output_%03d.mp4'
        ]);
    } catch (e) {
        throw new Error("Lỗi trong quá trình xử lý FFmpeg.");
    }

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
    
    try {
        await this.ffmpeg.deleteFile(inputFileName);
    } catch(e) {} // Bỏ qua lỗi xóa file input
    
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
    try {
        await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));
    } catch (e) {
         throw new Error("Lỗi nạp file video.");
    }

    onLog("Bắt đầu trích xuất frame...");
    
    this.ffmpeg.off('progress');
    this.ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      onProgress(Math.round(progress * 100));
    });

    try {
        await this.ffmpeg.exec([
        '-i', inputFileName,
        '-vf', 'fps=1',
        'frame_%04d.png'
        ]);
    } catch (e) {
        throw new Error("Lỗi khi chạy lệnh trích xuất.");
    }

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

    try {
        await this.ffmpeg.deleteFile(inputFileName);
    } catch(e) {}
    
    onLog(`Hoàn thành! Đã xử lý ${count} ảnh.`);
  }
}

export const ffmpegService = new FFmpegService();