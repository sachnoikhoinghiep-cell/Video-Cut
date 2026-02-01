import React, { useState, useRef, useEffect } from 'react';
import { Upload, FolderOutput, Scissors, Image as ImageIcon, Play, AlertCircle, FileVideo, CheckCircle, Terminal, Globe, Link as LinkIcon, Download, X, RefreshCw, Info, Wand2, HardDrive } from 'lucide-react';
import { Button } from './components/ui/Button';
import { ProcessingMode, AppStatus, FileSystemDirectoryHandle, LogMessage } from './types';
import { ffmpegService } from './utils/ffmpegService';

// Main Application Component
export default function App() {
  // State quản lý file đầu vào
  const [videoFile, setVideoFile] = useState<File | null>(null);
  // State quản lý thư mục đầu ra
  const [outputDir, setOutputDir] = useState<FileSystemDirectoryHandle | null>(null);
  // State chế độ fallback (khi không chọn được thư mục)
  const [isFallbackMode, setIsFallbackMode] = useState<boolean>(false);
  
  // State chế độ xử lý (Cắt hoặc Trích xuất ảnh)
  const [mode, setMode] = useState<ProcessingMode>(ProcessingMode.EXTRACT_FRAMES);
  // State số giây cắt (cho chế độ cắt video)
  const [segmentSeconds, setSegmentSeconds] = useState<number>(5);
  // Trạng thái ứng dụng (Loading, Processing, Idle...)
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  // Tiến trình xử lý (0-100%)
  const [progress, setProgress] = useState<number>(0);
  // Logs hiển thị cho người dùng
  const [logs, setLogs] = useState<LogMessage[]>([]);
  
  // State cho phần nhập URL
  const [inputType, setInputType] = useState<'upload' | 'url'>('upload');
  const [urlInput, setUrlInput] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<string>('');
  
  // Ref cho input file ẩn
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Ref để auto scroll logs
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll xuống cuối log
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Hàm thêm log mới
  const addLog = (text: string, type: LogMessage['type'] = 'info') => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      text,
      timestamp: new Date(),
      type
    }]);
  };

  // Reset file đã chọn
  const resetFile = () => {
    setVideoFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStatus(AppStatus.IDLE);
    setProgress(0);
    addLog('Đã hủy chọn file.', 'info');
  };

  // Hàm xử lý chọn file video từ máy
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('video/')) {
        addLog('File được chọn không phải là video hợp lệ.', 'error');
        return;
      }
      setVideoFile(file);
      addLog(`Đã tải lên video: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`, 'success');
      setStatus(AppStatus.IDLE);
      setProgress(0);
    }
  };

  /**
   * Helper: Trích xuất video từ link mạng xã hội (Youtube, Facebook, TikTok...)
   */
  const extractSocialVideo = async (url: string): Promise<string> => {
    try {
      setDownloadProgress('Đang phân tích link và tìm video gốc...');
      const response = await fetch('https://api.cobalt.tools/api/json', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: url })
      });

      if (!response.ok) throw new Error(`API Trích xuất lỗi (Status ${response.status})`);
      const data = await response.json();
      
      if (data.status === 'stream' || data.status === 'redirect') return data.url;
      if (data.status === 'picker' && data.picker && data.picker.length > 0) return data.picker[0].url;
      if (data.status === 'error') throw new Error(data.text || "Không tìm thấy video từ link này.");
      throw new Error("Không tìm thấy link video trực tiếp.");
    } catch (error) {
      console.warn("Extraction failed:", error);
      throw error;
    }
  };

  /**
   * Helper: Thử fetch video qua nhiều cách (Trực tiếp -> Proxy)
   */
  const fetchWithFallback = async (url: string): Promise<Response> => {
    const strategies = [
      { name: 'Trực tiếp (Direct)', fn: (u: string) => u },
      { name: 'Proxy 1 (corsproxy.io)', fn: (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}` },
      { name: 'Proxy 2 (allorigins)', fn: (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` }
    ];

    let lastError: any;
    for (const strategy of strategies) {
      try {
        setDownloadProgress(`Đang tải dữ liệu: ${strategy.name}...`);
        const targetUrl = strategy.fn(url);
        const response = await fetch(targetUrl);
        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('text/html')) throw new Error("IS_HTML_PAGE");
          return response;
        }
        throw new Error(`HTTP Error ${response.status}`);
      } catch (err) {
        if (err instanceof Error && err.message === 'IS_HTML_PAGE') throw err;
        lastError = err;
      }
    }
    throw lastError || new Error("Không thể kết nối đến file video.");
  };

  // Hàm xử lý download video từ URL
  const handleUrlDownload = async () => {
    let url = urlInput.trim();
    if (!url) {
      addLog('Vui lòng nhập đường dẫn URL.', 'error');
      return;
    }
    if (url.includes('youtube.com') && !url.includes('ssyoutube.com')) {
      url = url.replace('youtube.com', 'ssyoutube.com');
      addLog('Đã tự động chuyển đổi sang link ssYoutube theo yêu cầu.', 'info');
    }
    const isSocialLink = /youtube\.com|youtu\.be|facebook\.com|tiktok\.com|instagram\.com|x\.com|twitter\.com|ssyoutube\.com/.test(url);
    
    try {
      setIsDownloading(true);
      setDownloadProgress('Đang khởi tạo...');
      addLog(`Bắt đầu xử lý link: ${url}`, 'info');

      let targetUrl = url;
      let usedExtraction = false;

      if (isSocialLink) {
         try {
           const extractedUrl = await extractSocialVideo(url);
           targetUrl = extractedUrl;
           usedExtraction = true;
           addLog("Đã lấy được link video gốc!", "success");
         } catch (e: any) {
           if (url.includes('ssyoutube.com')) {
              try {
                const originalUrl = url.replace('ssyoutube.com', 'youtube.com');
                targetUrl = await extractSocialVideo(originalUrl);
                usedExtraction = true;
              } catch (fallbackErr: any) {}
           }
         }
      }

      let response: Response;
      try {
        response = await fetchWithFallback(targetUrl);
      } catch (e: any) {
        if (e.message === 'IS_HTML_PAGE' && !usedExtraction) {
            try {
                targetUrl = await extractSocialVideo(url);
                response = await fetchWithFallback(targetUrl);
            } catch (extractErr) {
               if (url.includes('ssyoutube.com')) {
                   try {
                       const originalUrl = url.replace('ssyoutube.com', 'youtube.com');
                       targetUrl = await extractSocialVideo(originalUrl);
                       response = await fetchWithFallback(targetUrl);
                   } catch (finalErr) {
                       throw new Error("Không thể trích xuất video từ trang này.");
                   }
               } else {
                   throw new Error("Không tìm thấy video.");
               }
            }
        } else {
             throw e;
        }
      }

      const blob = await response.blob();
      if (blob.size < 1000) throw new Error("File tải về quá nhỏ hoặc bị lỗi.");

      let fileName = `video_${Date.now()}.mp4`;
      try {
        const urlObj = new URL(targetUrl);
        const pathName = urlObj.pathname.split('/').pop();
        if (pathName && (pathName.endsWith('.mp4') || pathName.endsWith('.mkv'))) fileName = pathName;
      } catch (e) {}
      
      setVideoFile(new File([blob], fileName, { type: blob.type || 'video/mp4' }));
      addLog(`Download thành công! Đã lưu: ${fileName}`, 'success');
      setStatus(AppStatus.IDLE);
      setProgress(0);
      setDownloadProgress('');
    } catch (error: any) {
      addLog(`Lỗi download: ${error.message}`, 'error');
      setDownloadProgress('');
    } finally {
      setIsDownloading(false);
    }
  };

  // Hàm xử lý chọn thư mục lưu (Sử dụng File System Access API)
  const handleSelectOutputFolder = async () => {
    // Nếu đã ở chế độ fallback, cho phép người dùng thử lại chọn thư mục
    
    // Kiểm tra môi trường Secure Context
    if (!window.isSecureContext) {
      addLog("Môi trường không bảo mật (Not Secure). Chuyển sang chế độ Tải xuống Trình duyệt.", 'warning');
      setIsFallbackMode(true);
      setOutputDir(null);
      return true;
    }

    try {
      // @ts-ignore
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error("Trình duyệt không hỗ trợ API thư mục.");
      }

      // @ts-ignore
      const handle = await window.showDirectoryPicker();
      setOutputDir(handle);
      setIsFallbackMode(false); // Tắt fallback nếu chọn thành công
      addLog(`Đã chọn thư mục lưu: ${handle.name}`, 'success');
      return true;
    } catch (error: any) {
      // Nếu là lỗi người dùng hủy (AbortError), không làm gì cả
      if (error.name === 'AbortError') return false;

      // Nếu là lỗi Security hoặc Cross Origin (Iframe) -> Bật Fallback
      if (error.message.includes('Cross origin') || error.message.includes('Security') || error.name === 'SecurityError') {
        console.warn("Chuyển sang chế độ Fallback do lỗi bảo mật:", error);
        setIsFallbackMode(true);
        setOutputDir(null);
        addLog("Do hạn chế bảo mật trình duyệt (Iframe), ứng dụng sẽ chuyển sang chế độ Tự động tải xuống.", 'warning');
        return true; // Coi như thành công để tiếp tục flow
      }

      // Các lỗi khác (ví dụ trình duyệt không hỗ trợ) -> Cũng bật Fallback cho tiện
      setIsFallbackMode(true);
      setOutputDir(null);
      addLog(`Không thể chọn thư mục (${error.message}). Đã chuyển sang chế độ Tự động tải xuống.`, 'warning');
      return true;
    }
  };

  // Helper download file cho chế độ fallback
  const downloadFileBrowser = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Hàm bắt đầu xử lý
  const handleStartProcessing = async () => {
    if (!videoFile) {
      addLog('Vui lòng chọn video đầu vào.', 'error');
      return;
    }
    
    // Nếu chưa chọn thư mục và cũng chưa bật fallback -> Thử chọn thư mục
    if (!outputDir && !isFallbackMode) {
      addLog('Bạn chưa chọn nơi lưu. Đang mở hộp thoại...', 'warning');
      const result = await handleSelectOutputFolder();
      if (!result && !isFallbackMode) { // Nếu chọn thất bại và không tự bật fallback
         // Ở đây có thể người dùng hủy, ta nhắc lại
         addLog('Vui lòng chọn thư mục hoặc chấp nhận chế độ Tải xuống.', 'error');
         return;
      }
      // Nếu handleSelectOutputFolder trả về true (hoặc đã bật fallback), tiếp tục
      if (!outputDir && !isFallbackMode) {
         // Trường hợp hy hữu: handle trả về true nhưng chưa set outputDir và chưa set fallback (không nên xảy ra)
         return; 
      }
    }

    if (mode === ProcessingMode.CUT_SEGMENTS && segmentSeconds <= 0) {
      addLog('Số giây cắt phải lớn hơn 0.', 'error');
      return;
    }

    if (isFallbackMode && mode === ProcessingMode.EXTRACT_FRAMES) {
       addLog('Cảnh báo: Chế độ "Trích xuất Frame" sẽ tải xuống rất nhiều file ảnh. Trình duyệt có thể hỏi quyền tải nhiều file.', 'warning');
    }

    try {
      setStatus(AppStatus.LOADING_CORE);
      addLog('Đang khởi động engine xử lý video...');
      
      await ffmpegService.load();
      
      setStatus(AppStatus.PROCESSING);
      addLog(isFallbackMode ? 'Bắt đầu xử lý (Chế độ Tải xuống)...' : 'Bắt đầu xử lý (Chế độ Lưu file)...', 'info');

      // Callback chung cho việc tải file (nếu fallback)
      const onFileGenerated = (blob: Blob, filename: string) => {
         downloadFileBrowser(blob, filename);
      };

      if (mode === ProcessingMode.CUT_SEGMENTS) {
        await ffmpegService.cutVideo(
          videoFile,
          segmentSeconds,
          outputDir, // Có thể là null
          (p) => setProgress(p),
          (msg) => addLog(msg, 'info'),
          onFileGenerated
        );
      } else {
        await ffmpegService.extractFrames(
          videoFile,
          outputDir, // Có thể là null
          (p) => setProgress(p),
          (msg) => addLog(msg, 'info'),
          onFileGenerated
        );
      }

      setStatus(AppStatus.COMPLETED);
      if (isFallbackMode) {
        addLog('Hoàn tất! Các file đã được gửi lệnh tải xuống.', 'success');
      } else {
        addLog('Hoàn tất! Vui lòng kiểm tra thư mục đã chọn.', 'success');
      }
      setProgress(100);

    } catch (error: any) {
      console.error(error);
      setStatus(AppStatus.ERROR);
      if (error.message && error.message.includes('SharedArrayBuffer')) {
        addLog('Lỗi môi trường: Trình duyệt chặn tính năng bảo mật cần thiết (SharedArrayBuffer).', 'error');
      } else {
        addLog(`Lỗi xử lý: ${error.message || 'Không xác định'}`, 'error');
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-800 flex items-center justify-center gap-3">
            <FileVideo className="w-10 h-10 text-blue-600" />
            Video Cutter & Extractor
          </h1>
          <p className="text-slate-500">Công cụ xử lý video offline ngay trên trình duyệt của bạn</p>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
          
          {/* Section 1: Inputs */}
          <div className="p-6 md:p-8 space-y-8 border-b border-slate-100">
            
            <div className="grid md:grid-cols-2 gap-6">
              {/* Input Video Section */}
              <div className="space-y-3">
                <label className="block text-sm font-semibold text-slate-700">1. Video đầu vào</label>
                
                {videoFile ? (
                   <div className="border-2 border-blue-500 bg-blue-50 rounded-xl p-6 flex flex-col items-center justify-center text-center relative animate-in fade-in duration-300">
                     <button 
                       onClick={resetFile}
                       className="absolute top-2 right-2 p-1 text-slate-400 hover:text-red-500 transition-colors"
                       title="Bỏ chọn file"
                     >
                       <X className="w-5 h-5" />
                     </button>
                     <CheckCircle className="w-10 h-10 text-blue-600 mb-2" />
                     <p className="font-bold text-slate-900 truncate max-w-full px-2">{videoFile.name}</p>
                     <p className="text-sm text-slate-600 mb-1">{(videoFile.size / (1024 * 1024)).toFixed(2)} MB</p>
                     <p className="text-xs text-blue-600 font-medium bg-blue-100 px-2 py-1 rounded-full">Sẵn sàng xử lý</p>
                   </div>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="flex border-b border-slate-200 bg-slate-50">
                      <button 
                        onClick={() => setInputType('upload')}
                        className={`flex-1 py-2 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${inputType === 'upload' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
                      >
                        <Upload className="w-4 h-4" /> Tải file lên
                      </button>
                      <button 
                        onClick={() => setInputType('url')}
                        className={`flex-1 py-2 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${inputType === 'url' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
                      >
                        <LinkIcon className="w-4 h-4" /> Link trực tiếp
                      </button>
                    </div>

                    <div className="p-4 h-60 flex items-center justify-center">
                      {inputType === 'upload' ? (
                        <div 
                          className="w-full h-full border-2 border-dashed border-slate-300 hover:border-blue-400 hover:bg-slate-50 rounded-lg flex flex-col items-center justify-center cursor-pointer transition-all"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <input 
                            type="file" 
                            ref={fileInputRef} 
                            onChange={handleFileChange} 
                            accept="video/*" 
                            className="hidden" 
                          />
                          <Upload className="w-8 h-8 text-slate-400 mb-2" />
                          <p className="text-sm font-medium text-slate-600">Nhấn để chọn file</p>
                          <p className="text-xs text-slate-400 mt-1">MP4, MKV, MOV...</p>
                        </div>
                      ) : (
                        <div className="w-full h-full flex flex-col justify-start space-y-3 pt-2">
                          <div>
                            <label className="text-xs text-slate-500 font-medium mb-1 block">Nhập Link Video</label>
                            <div className="relative">
                              <Globe className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                              <input 
                                type="text"
                                value={urlInput}
                                onChange={(e) => setUrlInput(e.target.value)}
                                placeholder="https://youtube.com/..., facebook.com/..."
                                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                                onKeyDown={(e) => e.key === 'Enter' && handleUrlDownload()}
                              />
                            </div>
                          </div>
                          <div className="bg-blue-50 text-blue-700 p-2 rounded text-[11px] flex items-start gap-2">
                             <Wand2 className="w-4 h-4 shrink-0 mt-0.5 text-blue-600" />
                             <p>
                               <b>Hỗ trợ đa năng:</b> Hệ thống tự động nhận diện video từ nhiều nguồn (ssYoutube supported).
                             </p>
                          </div>
                          <Button 
                            variant="secondary" 
                            onClick={handleUrlDownload}
                            isLoading={isDownloading}
                            disabled={!urlInput}
                            className="w-full text-sm py-1.5"
                          >
                            {isDownloading ? 'Đang xử lý...' : (
                              <><Download className="w-4 h-4" /> Tải về & Chọn</>
                            )}
                          </Button>
                          {isDownloading && (
                             <p className="text-xs text-center text-blue-500 animate-pulse font-medium">{downloadProgress}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Output Folder / Method */}
              <div className="space-y-3">
                <label className="block text-sm font-semibold text-slate-700">2. Phương thức lưu</label>
                
                {!isFallbackMode ? (
                  // Chế độ bình thường: Chọn thư mục
                  <button 
                    type="button"
                    className={`w-full h-full min-h-[140px] border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center transition-colors cursor-pointer hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${outputDir ? 'border-green-500 bg-green-50' : 'border-slate-300'}`}
                    onClick={handleSelectOutputFolder}
                  >
                    {outputDir ? (
                      <>
                        <FolderOutput className="w-10 h-10 text-green-600 mb-2" />
                        <p className="font-medium text-slate-900">{outputDir.name}</p>
                        <p className="text-sm text-slate-500">Đã chọn nơi lưu file</p>
                        <p className="text-xs text-green-600 mt-1 font-medium bg-green-100 px-2 py-0.5 rounded">Nhấn để thay đổi</p>
                      </>
                    ) : (
                      <>
                        <FolderOutput className="w-10 h-10 text-slate-400 mb-2" />
                        <p className="font-medium text-slate-600">Chọn thư mục lưu</p>
                        <p className="text-sm text-slate-400">Nơi chứa file sau khi cắt/trích xuất</p>
                      </>
                    )}
                  </button>
                ) : (
                  // Chế độ Fallback: Tự động tải xuống
                  <div className="w-full h-full min-h-[140px] border-2 border-orange-200 bg-orange-50 rounded-xl p-6 flex flex-col items-center justify-center text-center">
                    <HardDrive className="w-10 h-10 text-orange-500 mb-2" />
                    <p className="font-medium text-slate-900">Chế độ Tải xuống tự động</p>
                    <p className="text-xs text-slate-600 mt-1 px-2">
                       Do hạn chế bảo mật trình duyệt, ứng dụng sẽ gửi file cho bạn tải về thay vì lưu trực tiếp.
                    </p>
                    <button 
                      onClick={() => { setIsFallbackMode(false); handleSelectOutputFolder(); }}
                      className="mt-3 text-xs text-blue-600 underline hover:text-blue-800"
                    >
                      Thử chọn lại thư mục
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Mode Selection */}
            <div className="space-y-4">
              <label className="block text-sm font-semibold text-slate-700">3. Tùy chọn chế độ</label>
              <div className="grid md:grid-cols-2 gap-4">
                
                {/* Mode 1: Extract Frames */}
                <label 
                  className={`relative flex items-start p-4 cursor-pointer rounded-lg border-2 transition-all ${mode === ProcessingMode.EXTRACT_FRAMES ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-slate-200 hover:border-slate-300'}`}
                >
                  <input 
                    type="radio" 
                    name="mode" 
                    className="sr-only"
                    checked={mode === ProcessingMode.EXTRACT_FRAMES} 
                    onChange={() => setMode(ProcessingMode.EXTRACT_FRAMES)} 
                  />
                  <ImageIcon className={`w-6 h-6 mt-0.5 mr-3 ${mode === ProcessingMode.EXTRACT_FRAMES ? 'text-blue-600' : 'text-slate-400'}`} />
                  <div>
                    <span className="block font-medium text-slate-900">Trích xuất Frame (Ảnh)</span>
                    <span className="block text-sm text-slate-500 mt-1">Xuất hình ảnh từ video (mặc định 1 ảnh/giây).</span>
                  </div>
                </label>

                {/* Mode 2: Cut Segments */}
                <label 
                  className={`relative flex items-start p-4 cursor-pointer rounded-lg border-2 transition-all ${mode === ProcessingMode.CUT_SEGMENTS ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-slate-200 hover:border-slate-300'}`}
                >
                  <input 
                    type="radio" 
                    name="mode" 
                    className="sr-only"
                    checked={mode === ProcessingMode.CUT_SEGMENTS} 
                    onChange={() => setMode(ProcessingMode.CUT_SEGMENTS)} 
                  />
                  <Scissors className={`w-6 h-6 mt-0.5 mr-3 ${mode === ProcessingMode.CUT_SEGMENTS ? 'text-blue-600' : 'text-slate-400'}`} />
                  <div className="flex-1">
                    <span className="block font-medium text-slate-900">Cắt Video tự động</span>
                    <span className="block text-sm text-slate-500 mt-1 mb-3">Chia nhỏ video thành các clip.</span>
                    
                    {/* Input Seconds inside the radio card for better UX */}
                    <div className={`flex items-center gap-2 ${mode !== ProcessingMode.CUT_SEGMENTS ? 'opacity-50 pointer-events-none' : ''}`}>
                      <span className="text-sm font-medium text-slate-700">Mỗi:</span>
                      <input 
                        type="number" 
                        min="1"
                        value={segmentSeconds}
                        onChange={(e) => setSegmentSeconds(parseInt(e.target.value) || 0)}
                        className="w-20 px-2 py-1 text-sm border border-slate-300 rounded focus:border-blue-500 focus:outline-none"
                      />
                      <span className="text-sm text-slate-500">giây</span>
                    </div>
                  </div>
                </label>

              </div>
            </div>

            {/* Action Button */}
            <div className="pt-4 flex justify-center">
              <Button 
                onClick={handleStartProcessing} 
                disabled={status === AppStatus.PROCESSING || status === AppStatus.LOADING_CORE || isDownloading}
                className="w-full md:w-auto px-12 py-3 text-lg shadow-lg shadow-blue-500/30"
                isLoading={status === AppStatus.PROCESSING || status === AppStatus.LOADING_CORE}
              >
                {status === AppStatus.IDLE || status === AppStatus.ERROR || status === AppStatus.COMPLETED ? (
                  <>
                    <Play className="w-5 h-5" /> {isFallbackMode ? 'Bắt đầu xử lý & Tải xuống' : 'Bắt đầu xử lý'}
                  </>
                ) : (
                  'Đang xử lý...'
                )}
              </Button>
            </div>
          </div>

          {/* Section 2: Progress & Logs */}
          <div className="bg-slate-900 text-slate-200 p-6 md:p-8">
            <div className="flex items-center gap-2 mb-4">
              <Terminal className="w-5 h-5 text-slate-400" />
              <h3 className="font-mono text-sm uppercase tracking-wider text-slate-400">Console Log</h3>
              {logs.length > 0 && (
                <button 
                  onClick={() => setLogs([])} 
                  className="ml-auto text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Clear
                </button>
              )}
            </div>

            {/* Progress Bar */}
            {(status === AppStatus.PROCESSING || status === AppStatus.COMPLETED) && (
              <div className="mb-6">
                <div className="flex justify-between text-xs mb-1">
                  <span>Tiến độ</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2.5 overflow-hidden">
                  <div 
                    className={`h-2.5 rounded-full transition-all duration-300 ${status === AppStatus.COMPLETED ? 'bg-green-500' : 'bg-blue-500'}`} 
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
              </div>
            )}

            {/* Log Output Area */}
            <div className="h-64 overflow-y-auto font-mono text-xs md:text-sm space-y-1 pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
              {logs.length === 0 && (
                <div className="text-slate-600 italic">Chưa có hoạt động nào...</div>
              )}
              {logs.map((log) => (
                <div key={log.id} className="flex gap-2">
                  <span className="text-slate-500">[{log.timestamp.toLocaleTimeString()}]</span>
                  <span className={
                    log.type === 'error' ? 'text-red-400' :
                    log.type === 'success' ? 'text-green-400' :
                    log.type === 'warning' ? 'text-yellow-400' :
                    'text-slate-300'
                  }>
                    {log.type === 'error' && <AlertCircle className="w-3 h-3 inline mr-1" />}
                    {log.type === 'success' && <CheckCircle className="w-3 h-3 inline mr-1" />}
                    {log.type === 'warning' && <AlertCircle className="w-3 h-3 inline mr-1" />}
                    {log.text}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400">
          Lưu ý: Ứng dụng sử dụng tài nguyên máy tính của bạn để xử lý video. <br/>
          Nếu gặp lỗi, vui lòng đảm bảo bạn đang sử dụng trình duyệt Chrome/Edge phiên bản mới nhất.
        </p>
      </div>
    </div>
  );
}