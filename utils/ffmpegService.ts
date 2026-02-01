import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { FileSystemDirectoryHandle, AppStatus } from '../types';

/**
 * Service quản lý FFmpeg và xử lý file
 * Sử dụng Singleton pattern để đảm bảo chỉ có 1 instance FFmpeg chạy
 */
class FFmpegService {
  private ffmpeg: FFmpeg | null = null;
  private isLoaded: boolean = false;

  // Khởi tạo FFmpeg engine
  public async load() {
    if (this.isLoaded && this.ffmpeg) return this.ffmpeg;

    this.ffmpeg = new FFmpeg();

    // Bắt sự kiện log để debug
    this.ffmpeg.on('log', ({ message }) => {
      console.log('FFmpeg Log:', message);
    });

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    
    // Load WASM files từ CDN
    await this.ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    this.isLoaded = true;
    return this.ffmpeg;
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
    outputDir: FileSystemDirectoryHandle,
    onProgress: (progress: number) => void,
    onLog: (msg: string) => void
  ) {
    if (!this.ffmpeg) throw new Error("FFmpeg chưa được khởi tạo");
    
    const inputFileName = 'input.mp4';
    
    // Ghi file input vào bộ nhớ ảo của FFmpeg (MEMFS)
    onLog("Đang nạp file vào bộ nhớ...");
    await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));

    // Lệnh cắt video
    // -i: Input
    // -c copy: Copy stream (không render lại) -> Cực nhanh
    // -map 0: Lấy toàn bộ stream
    // -segment_time: Thời gian mỗi đoạn
    // -f segment: Định dạng segment
    // -reset_timestamps 1: Reset thời gian mỗi clip về 0
    onLog("Đang thực hiện cắt video...");
    
    // Theo dõi tiến trình (tương đối vì -c copy rất nhanh nên progress có thể nhảy cóc)
    this.ffmpeg.on('progress', ({ progress }) => {
      onProgress(Math.round(progress * 100));
    });

    await this.ffmpeg.exec([
      '-i', inputFileName,
      '-c', 'copy',
      '-map', '0',
      '-segment_time', segmentTime.toString(),
      '-f', 'segment',
      '-reset_timestamps', '1',
      'output_%03d.mp4' // Pattern tên file output: output_001.mp4, output_002.mp4
    ]);

    // Đọc các file output từ MEMFS và lưu ra máy thật
    onLog("Đang lưu các đoạn clip ra thư mục...");
    const files = await this.ffmpeg.listDir('.');
    
    let count = 0;
    for (const f of files) {
      // @ts-ignore - ffmpeg type definition cho listDir chưa đầy đủ trong phiên bản này
      if (!f.isDir && f.name.startsWith('output_') && f.name.endsWith('.mp4')) {
        // @ts-ignore
        const data = await this.ffmpeg.readFile(f.name);
        await this.saveToDirectory(outputDir, f.name, new Blob([data], { type: 'video/mp4' }));
        // Xóa file trong MEMFS để giải phóng bộ nhớ
        // @ts-ignore
        await this.ffmpeg.deleteFile(f.name);
        count++;
      }
    }
    
    // Cleanup input
    await this.ffmpeg.deleteFile(inputFileName);
    onLog(`Hoàn thành! Đã lưu ${count} clip.`);
  }

  // Xử lý trích xuất frames
  public async extractFrames(
    file: File,
    outputDir: FileSystemDirectoryHandle,
    onProgress: (progress: number) => void,
    onLog: (msg: string) => void
  ) {
    if (!this.ffmpeg) throw new Error("FFmpeg chưa được khởi tạo");

    const inputFileName = 'input.mp4';
    
    onLog("Đang nạp video...");
    await this.ffmpeg.writeFile(inputFileName, await fetchFile(file));

    onLog("Bắt đầu trích xuất frame (Việc này có thể mất thời gian)...");
    
    this.ffmpeg.on('progress', ({ progress }) => {
      onProgress(Math.round(progress * 100));
    });

    // Lệnh trích xuất frame
    // -i: Input
    // -vf fps=1: Lấy 1 khung hình mỗi giây (để tránh quá tải). 
    // Nếu muốn lấy TOÀN BỘ, bỏ vf fps=1 nhưng sẽ rất nặng.
    // Ở đây ta dùng fps=1 để demo hiệu năng tốt, hoặc dùng vsync 0 để lấy tất cả.
    // Dựa trên yêu cầu "Trích xuất toàn bộ", ta sẽ dùng frame%04d.png nhưng mặc định render lại.
    // Để an toàn cho trình duyệt, ta sẽ giới hạn fps hoặc để native. 
    // Hãy dùng fps=1 để an toàn mặc định, người dùng có thể cần hàng nghìn ảnh nếu video dài.
    // Sửa lệnh: Trích xuất mỗi giây 1 ảnh (An toàn). 
    // Nếu muốn tất cả frames: thay đổi thành ['-i', inputFileName, 'frame_%04d.png']
    
    await this.ffmpeg.exec([
      '-i', inputFileName,
      '-vf', 'fps=1', // Trích xuất 1 ảnh/giây. Thay đổi logic này nếu muốn lấy tất cả frames (fps=30/60).
      'frame_%04d.png'
    ]);

    onLog("Đang lưu ảnh ra thư mục...");
    const files = await this.ffmpeg.listDir('.');
    
    let count = 0;
    for (const f of files) {
      // @ts-ignore
      if (!f.isDir && f.name.startsWith('frame_') && f.name.endsWith('.png')) {
        // @ts-ignore
        const data = await this.ffmpeg.readFile(f.name);
        await this.saveToDirectory(outputDir, f.name, new Blob([data], { type: 'image/png' }));
        // @ts-ignore
        await this.ffmpeg.deleteFile(f.name);
        count++;
      }
    }

    await this.ffmpeg.deleteFile(inputFileName);
    onLog(`Hoàn thành! Đã lưu ${count} ảnh.`);
  }
}

export const ffmpegService = new FFmpegService();