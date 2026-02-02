import React, { useState, useRef, useEffect } from 'react';
import { Upload, FolderOutput, Scissors, Image as ImageIcon, Play, AlertCircle, FileVideo, CheckCircle, Terminal, Globe, Link as LinkIcon, Download, X, RefreshCw, Info, Wand2, HardDrive, Cloud, Settings } from 'lucide-react';
import { Button } from './components/ui/Button';
import { ProcessingMode, AppStatus, FileSystemDirectoryHandle, LogMessage, DriveFolder, GoogleDriveConfig } from './types';
import { ffmpegService } from './utils/ffmpegService';
import { googleDriveService } from './utils/googleDriveService';

// --- CẤU HÌNH MẶC ĐỊNH ---
// Helper to safely access process.env
const getEnv = (key: string) => {
  try {
    // @ts-ignore
    return (typeof process !== 'undefined' && process.env && process.env[key]) || "";
  } catch (e) {
    return "";
  }
};

const DEFAULT_GOOGLE_CONFIG = {
  // Ưu tiên biến môi trường, sau đó đến giá trị hardcode
  clientId: getEnv('REACT_APP_GOOGLE_CLIENT_ID'), 
  apiKey: getEnv('REACT_APP_GOOGLE_API_KEY'),
  appId: getEnv('REACT_APP_GOOGLE_APP_ID')
};

// Main Application Component
export default function App() {
  // State quản lý file đầu vào
  const [videoFile, setVideoFile] = useState<File | null>(null);
  
  // State quản lý đầu ra (Drive hoặc Local)
  const [useDrive, setUseDrive] = useState<boolean>(true); // Mặc định dùng Drive
  const [driveFolder, setDriveFolder] = useState<DriveFolder | null>(null);
  const [outputDir, setOutputDir] = useState<FileSystemDirectoryHandle | null>(null);
  
  // Google Config State
  // Thứ tự ưu tiên: LocalStorage -> Default Config (Hardcode/Env) -> Rỗng
  const [driveConfig, setDriveConfig] = useState<GoogleDriveConfig>({
    clientId: localStorage.getItem('gdrive_client_id') || DEFAULT_GOOGLE_CONFIG.clientId,
    apiKey: localStorage.getItem('gdrive_api_key') || DEFAULT_GOOGLE_CONFIG.apiKey,
    appId: localStorage.getItem('gdrive_app_id') || DEFAULT_GOOGLE_CONFIG.appId
  });
  const [showConfig, setShowConfig] = useState(false);
  const [pendingConnect, setPendingConnect] = useState(false);

  // State chế độ fallback (khi không chọn được thư mục và không dùng Drive)
  const [isFallbackMode, setIsFallbackMode] = useState<boolean>(false);
  
  // State chế độ xử lý (Cắt hoặc Trích xuất ảnh)
  const [mode, setMode] = useState<ProcessingMode>(ProcessingMode.EXTRACT_FRAMES);
  // State số giây cắt (cho chế độ cắt video)
  const [segmentSeconds, setSegmentSeconds] = useState<number>(5);
  // Trạng thái ứng dụng
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [progress, setProgress] = useState<number>(0);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  
  // State cho phần nhập URL
  const [inputType, setInputType] = useState<'upload' | 'url'>('upload');
  const [urlInput, setUrlInput] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<string>('');
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Khởi tạo Google Service khi config thay đổi
  useEffect(() => {
    // Chỉ init nếu có config hợp lệ (độ dài > 5 để tránh giá trị rác)
    if (driveConfig.clientId?.length > 5 && driveConfig.apiKey?.length > 5) {
      googleDriveService.setConfig(driveConfig);
      googleDriveService.init()
        .then(() => {
            // Nếu pendingConnect = true (người dùng vừa bấm connect nhưng chưa có key), giờ key đã có -> tự động connect lại
            if (pendingConnect) {
              setPendingConnect(false);
              handleConnectDrive();
            }
        })
        .catch(err => {
            console.error("GAPI Init Error", err);
            addLog("Lỗi khởi tạo Google Drive API. Vui lòng kiểm tra cấu hình.", 'warning');
        });
    }
  }, [driveConfig]); // Add dependency to re-run when config changes

  // Auto scroll xuống cuối log
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (text: string, type: LogMessage['type'] = 'info') => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      text,
      timestamp: new Date(),
      type
    }]);
  };

  const saveConfig = () => {
    localStorage.setItem('gdrive_client_id', driveConfig.clientId);
    localStorage.setItem('gdrive_api_key', driveConfig.apiKey);
    localStorage.setItem('gdrive_app_id', driveConfig.appId || '');
    
    // Khi save, state driveConfig sẽ update -> Trigger useEffect init
    setShowConfig(false);
    addLog("Đã lưu cấu hình. Đang khởi tạo kết nối...", 'info');
    
    // Nếu đang đợi connect thì useEffect sẽ lo việc gọi handleConnectDrive
  };

  const resetFile = () => {
    setVideoFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStatus(AppStatus.IDLE);
    setProgress(0);
    addLog('Đã hủy chọn file.', 'info');
  };

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

  // --- Logic Download URL (Giữ nguyên) ---
  const extractSocialVideo = async (url: string): Promise<string> => {
    try {
      setDownloadProgress('Đang phân tích link và tìm video gốc...');
      const response = await fetch('https://api.cobalt.tools/api/json', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      });
      if (!response.ok) throw new Error(`API Trích xuất lỗi (Status ${response.status})`);
      const data = await response.json();
      if (data.status === 'stream' || data.status === 'redirect') return data.url;
      if (data.status === 'picker' && data.picker && data.picker.length > 0) return data.picker[0].url;
      throw new Error("Không tìm thấy link video trực tiếp.");
    } catch (error) { throw error; }
  };

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
      } catch (err) { if (err instanceof Error && err.message === 'IS_HTML_PAGE') throw err; lastError = err; }
    }
    throw lastError || new Error("Không thể kết nối đến file video.");
  };

  const handleUrlDownload = async () => {
    let url = urlInput.trim();
    if (!url) { addLog('Vui lòng nhập đường dẫn URL.', 'error'); return; }
    if (url.includes('youtube.com') && !url.includes('ssyoutube.com')) url = url.replace('youtube.com', 'ssyoutube.com');
    const isSocialLink = /youtube\.com|youtu\.be|facebook\.com|tiktok\.com|instagram\.com|x\.com|twitter\.com|ssyoutube\.com/.test(url);
    try {
      setIsDownloading(true); setDownloadProgress('Đang khởi tạo...');
      let targetUrl = url;
      if (isSocialLink) {
         try { targetUrl = await extractSocialVideo(url); } catch (e) {}
      }
      const response = await fetchWithFallback(targetUrl);
      const blob = await response.blob();
      setVideoFile(new File([blob], `video_${Date.now()}.mp4`, { type: blob.type || 'video/mp4' }));
      addLog(`Download thành công!`, 'success');
      setStatus(AppStatus.IDLE); setProgress(0); setDownloadProgress('');
    } catch (error: any) {
      addLog(`Lỗi download: ${error.message}`, 'error');
    } finally { setIsDownloading(false); }
  };

  // --- Logic Drive & Folder ---

  const handleConnectDrive = async () => {
    // Check config validity
    if (!driveConfig.clientId || !driveConfig.apiKey || driveConfig.clientId.length < 5) {
      setShowConfig(true);
      setPendingConnect(true); // Đánh dấu là user đang muốn connect
      addLog("Vui lòng nhập Client ID và API Key để tiếp tục.", 'warning');
      return;
    }
    
    // Nếu chưa khởi tạo service (do useEffect chưa chạy hoặc config mới update), thử init lại
    googleDriveService.setConfig(driveConfig);
    
    try {
      addLog("Đang kết nối Google Drive...", 'info');
      
      // Đảm bảo thư viện đã load
      await googleDriveService.init();
      
      const folder = await googleDriveService.pickFolder();
      setDriveFolder(folder);
      setUseDrive(true);
      setOutputDir(null); // Reset local folder
      setIsFallbackMode(false);
      addLog(`Đã chọn thư mục Drive: ${folder.name}`, 'success');
    } catch (e: any) {
      if (e.message?.includes('Google Service chưa khởi tạo') || e.message?.includes('Script error')) {
           addLog("Đang tải thư viện Google, vui lòng thử lại sau 2 giây...", 'warning');
           // Retry silent init
           googleDriveService.init().catch(()=>{});
      } else {
           addLog(`Lỗi kết nối Drive: ${e.message || e}`, 'error');
           if (e.message?.includes("origin_mismatch")) {
             addLog("Gợi ý: Kiểm tra 'Authorized JavaScript origins' trong Google Cloud Console.", 'info');
           }
      }
    }
  };

  const handleSelectLocalFolder = async () => {
    if (!window.isSecureContext) {
      addLog("Môi trường không bảo mật. Chuyển sang tải xuống.", 'warning');
      setIsFallbackMode(true); return;
    }
    try {
      // @ts-ignore
      const handle = await window.showDirectoryPicker();
      setOutputDir(handle);
      setUseDrive(false);
      setDriveFolder(null);
      setIsFallbackMode(false);
      addLog(`Đã chọn thư mục local: ${handle.name}`, 'success');
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        setIsFallbackMode(true);
        setOutputDir(null);
      }
    }
  };

  const downloadFileBrowser = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleStartProcessing = async () => {
    if (!videoFile) { addLog('Vui lòng chọn video đầu vào.', 'error'); return; }
    
    // Validate output destination
    if (useDrive && !driveFolder) {
      addLog('Vui lòng chọn thư mục trên Google Drive.', 'error');
      handleConnectDrive();
      return;
    }
    if (!useDrive && !outputDir && !isFallbackMode) {
      addLog('Vui lòng chọn thư mục lưu hoặc chế độ tải xuống.', 'error');
      return;
    }

    try {
      setStatus(AppStatus.LOADING_CORE);
      addLog('Đang khởi động engine xử lý video...');
      await ffmpegService.load();
      
      setStatus(AppStatus.PROCESSING);
      addLog('Đang xử lý video...', 'info');

      // Callback xử lý từng file được sinh ra
      const onFileGenerated = async (blob: Blob, filename: string) => {
        if (useDrive && driveFolder) {
           addLog(`Đang upload ${filename} lên Drive...`, 'info');
           try {
             await googleDriveService.uploadFile(blob, filename, driveFolder.id);
             addLog(`Đã upload xong: ${filename}`, 'success');
           } catch (e) {
             addLog(`Lỗi upload ${filename}: ${e}`, 'error');
           }
        } else if (isFallbackMode) {
           downloadFileBrowser(blob, filename);
        } else {
           // Nếu là local folder, ffmpegService đã tự handle việc ghi file thông qua tham số outputDir
           // Không cần làm gì ở đây trừ khi muốn log thêm
        }
      };

      const options = {
        onProgress: (p: number) => setProgress(p),
        onLog: (msg: string) => { 
           // Filter bớt log ffmpeg cho đỡ rối
           if(!msg.includes("frame=")) addLog(msg, 'info'); 
        },
        onFileGenerated: onFileGenerated
      };

      if (mode === ProcessingMode.CUT_SEGMENTS) {
        await ffmpegService.cutVideo(
          videoFile, segmentSeconds,
          useDrive ? null : outputDir, // Nếu dùng Drive thì pass null để kích hoạt onFileGenerated
          options.onProgress, options.onLog, options.onFileGenerated
        );
      } else {
        await ffmpegService.extractFrames(
          videoFile,
          useDrive ? null : outputDir,
          options.onProgress, options.onLog, options.onFileGenerated
        );
      }

      setStatus(AppStatus.COMPLETED);
      addLog('Tất cả tác vụ đã hoàn tất!', 'success');
      setProgress(100);

    } catch (error: any) {
      console.error(error);
      setStatus(AppStatus.ERROR);
      addLog(`Lỗi: ${error.message}`, 'error');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="text-center space-y-2 relative">
           <button 
             onClick={() => setShowConfig(true)}
             className="absolute right-0 top-0 p-2 text-slate-400 hover:text-blue-600 transition-colors"
             title="Cấu hình Google Drive"
           >
             <Settings className="w-6 h-6" />
           </button>
          <h1 className="text-3xl md:text-4xl font-bold text-slate-800 flex items-center justify-center gap-3">
            <FileVideo className="w-10 h-10 text-blue-600" />
            Video Cutter Pro
          </h1>
          <p className="text-slate-500">Cắt & Trích xuất video - Hỗ trợ lưu trực tiếp Google Drive</p>
        </div>

        {/* Config Modal */}
        {showConfig && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
             <div className="bg-white p-6 rounded-2xl shadow-2xl max-w-md w-full animate-in fade-in zoom-in duration-200">
                 <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-xl text-slate-800 flex items-center gap-2">
                       <Settings className="w-5 h-5 text-blue-600" /> Cấu hình Google Drive API
                    </h3>
                    <button onClick={() => setShowConfig(false)} className="text-slate-400 hover:text-red-500"><X className="w-5 h-5" /></button>
                 </div>
                 
                 <div className="space-y-4">
                   <div className="p-3 bg-blue-50 text-blue-700 rounded-lg text-sm flex gap-2">
                      <Info className="w-5 h-5 flex-shrink-0" />
                      Để lưu file vào Drive, bạn cần nhập API Key và Client ID từ Google Cloud Console.
                   </div>

                   <div>
                     <label className="block text-sm font-semibold text-slate-700 mb-1">Client ID</label>
                     <input 
                       type="text" 
                       value={driveConfig.clientId}
                       onChange={e => setDriveConfig({...driveConfig, clientId: e.target.value})}
                       className="w-full border border-slate-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                       placeholder="xxxx.apps.googleusercontent.com"
                     />
                   </div>
                   
                   <div>
                     <label className="block text-sm font-semibold text-slate-700 mb-1">API Key</label>
                     <input 
                       type="text" 
                       value={driveConfig.apiKey}
                       onChange={e => setDriveConfig({...driveConfig, apiKey: e.target.value})}
                       className="w-full border border-slate-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                       placeholder="AIzaSy..."
                     />
                   </div>
                   
                   <div>
                     <label className="block text-sm font-semibold text-slate-700 mb-1">App ID (Project Number - Optional)</label>
                     <input 
                       type="text" 
                       value={driveConfig.appId}
                       onChange={e => setDriveConfig({...driveConfig, appId: e.target.value})}
                       className="w-full border border-slate-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                       placeholder="123456789"
                     />
                   </div>

                   <div className="flex justify-end gap-3 mt-6">
                     <Button variant="secondary" onClick={() => setShowConfig(false)}>Hủy</Button>
                     <Button onClick={saveConfig}>Lưu & Kết nối</Button>
                   </div>
                 </div>
             </div>
          </div>
        )}

        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
          
          <div className="p-6 md:p-8 space-y-8 border-b border-slate-100">
            <div className="grid md:grid-cols-2 gap-6">
              
              {/* 1. Input Video */}
              <div className="space-y-3">
                <label className="block text-sm font-semibold text-slate-700">1. Video đầu vào</label>
                {videoFile ? (
                   <div className="border-2 border-blue-500 bg-blue-50 rounded-xl p-6 flex flex-col items-center justify-center text-center relative animate-in fade-in zoom-in duration-300">
                     <button onClick={resetFile} className="absolute top-2 right-2 p-1 text-slate-400 hover:text-red-500"><X className="w-5 h-5" /></button>
                     <CheckCircle className="w-10 h-10 text-blue-600 mb-2" />
                     <p className="font-bold text-slate-900 truncate max-w-full px-2">{videoFile.name}</p>
                     <p className="text-sm text-slate-600">{(videoFile.size / (1024 * 1024)).toFixed(2)} MB</p>
                   </div>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-hidden h-60">
                    <div className="flex border-b bg-slate-50">
                      <button onClick={() => setInputType('upload')} className={`flex-1 py-2 text-sm font-medium transition-colors ${inputType === 'upload' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'text-slate-500 hover:bg-slate-100'}`}>Upload</button>
                      <button onClick={() => setInputType('url')} className={`flex-1 py-2 text-sm font-medium transition-colors ${inputType === 'url' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'text-slate-500 hover:bg-slate-100'}`}>URL</button>
                    </div>
                    <div className="p-4 h-full flex items-center justify-center">
                      {inputType === 'upload' ? (
                        <div className="w-full h-40 border-2 border-dashed border-slate-300 hover:border-blue-400 hover:bg-blue-50 transition-all rounded-lg flex flex-col items-center justify-center cursor-pointer group" onClick={() => fileInputRef.current?.click()}>
                          <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="video/*" className="hidden" />
                          <Upload className="w-8 h-8 text-slate-400 group-hover:text-blue-500 mb-2 transition-colors" />
                          <p className="text-sm text-slate-600 group-hover:text-blue-600">Click để chọn file</p>
                        </div>
                      ) : (
                        <div className="w-full space-y-2">
                           <input type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="Dán link video vào đây..." className="w-full border border-slate-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                           <Button onClick={handleUrlDownload} isLoading={isDownloading} className="w-full text-sm" disabled={!urlInput}>
                             <Download className="w-4 h-4" /> Tải về & Chọn
                           </Button>
                           <p className="text-xs text-center text-blue-500 min-h-[1rem]">{downloadProgress}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 2. Output Destination */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                   <label className="block text-sm font-semibold text-slate-700">2. Nơi lưu file</label>
                   <div className="flex text-xs border rounded-lg overflow-hidden p-0.5 bg-slate-100">
                      <button onClick={() => { setUseDrive(true); setIsFallbackMode(false); }} className={`px-3 py-1.5 rounded-md transition-all ${useDrive ? 'bg-white text-blue-700 font-bold shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Google Drive</button>
                      <button onClick={() => { setUseDrive(false); setDriveFolder(null); }} className={`px-3 py-1.5 rounded-md transition-all ${!useDrive ? 'bg-white text-blue-700 font-bold shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Local/Tải về</button>
                   </div>
                </div>
                
                {useDrive ? (
                  // Drive Mode
                  <button 
                    type="button"
                    className={`w-full h-full min-h-[140px] border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center transition-all cursor-pointer hover:bg-slate-50 relative group ${driveFolder ? 'border-blue-500 bg-blue-50' : 'border-slate-300'}`}
                    onClick={handleConnectDrive}
                  >
                    <Cloud className={`w-12 h-12 mb-3 transition-colors ${driveFolder ? 'text-blue-600' : 'text-slate-400 group-hover:text-blue-500'}`} />
                    {driveFolder ? (
                      <>
                        <p className="font-bold text-slate-900 line-clamp-1">{driveFolder.name}</p>
                        <p className="text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded mt-1">Đã kết nối</p>
                        <span className="absolute top-2 right-2 text-blue-400 hover:text-blue-600" title="Đổi thư mục"><RefreshCw className="w-4 h-4"/></span>
                      </>
                    ) : (
                      <>
                        <p className="font-medium text-slate-700 group-hover:text-blue-700">Kết nối Google Drive</p>
                        <p className="text-xs text-slate-400 mt-1">Lưu trực tiếp không cần tải về</p>
                      </>
                    )}
                  </button>
                ) : (
                  // Local Mode
                  <button 
                    type="button"
                    className={`w-full h-full min-h-[140px] border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center hover:bg-slate-50 transition-all ${outputDir ? 'border-green-500 bg-green-50' : isFallbackMode ? 'border-orange-300 bg-orange-50' : 'border-slate-300'}`}
                    onClick={handleSelectLocalFolder}
                  >
                    {isFallbackMode ? <HardDrive className="w-10 h-10 text-orange-500 mb-3"/> : <FolderOutput className={`w-10 h-10 mb-3 ${outputDir ? 'text-green-600' : 'text-slate-400'}`} />}
                    {outputDir ? (
                      <p className="font-bold text-slate-900">{outputDir.name}</p>
                    ) : isFallbackMode ? (
                      <p className="font-medium text-slate-900">Tự động tải xuống</p>
                    ) : (
                      <p className="font-medium text-slate-600">Chọn thư mục máy tính</p>
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* 3. Options */}
            <div className="space-y-4">
              <label className="block text-sm font-semibold text-slate-700">3. Tùy chọn xử lý</label>
              <div className="grid md:grid-cols-2 gap-4">
                <label className={`relative flex p-4 cursor-pointer rounded-xl border-2 transition-all hover:shadow-md ${mode === ProcessingMode.EXTRACT_FRAMES ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-blue-300'}`}>
                  <input type="radio" name="mode" className="sr-only" checked={mode === ProcessingMode.EXTRACT_FRAMES} onChange={() => setMode(ProcessingMode.EXTRACT_FRAMES)} />
                  <div className={`p-2 rounded-full mr-4 ${mode === ProcessingMode.EXTRACT_FRAMES ? 'bg-blue-100' : 'bg-slate-100'}`}>
                     <ImageIcon className={`w-6 h-6 ${mode === ProcessingMode.EXTRACT_FRAMES ? 'text-blue-600' : 'text-slate-500'}`} />
                  </div>
                  <div>
                    <span className="block font-bold text-slate-800">Trích xuất Frame</span>
                    <span className="text-sm text-slate-500">Xuất ảnh PNG từng giây</span>
                  </div>
                </label>
                <label className={`relative flex p-4 cursor-pointer rounded-xl border-2 transition-all hover:shadow-md ${mode === ProcessingMode.CUT_SEGMENTS ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-blue-300'}`}>
                  <input type="radio" name="mode" className="sr-only" checked={mode === ProcessingMode.CUT_SEGMENTS} onChange={() => setMode(ProcessingMode.CUT_SEGMENTS)} />
                  <div className={`p-2 rounded-full mr-4 ${mode === ProcessingMode.CUT_SEGMENTS ? 'bg-blue-100' : 'bg-slate-100'}`}>
                     <Scissors className={`w-6 h-6 ${mode === ProcessingMode.CUT_SEGMENTS ? 'text-blue-600' : 'text-slate-500'}`} />
                  </div>
                  <div className="flex-1">
                    <span className="block font-bold text-slate-800">Cắt Video</span>
                    <div className="flex items-center gap-2 mt-1">
                       <span className="text-sm text-slate-500">Độ dài:</span>
                       <div className="flex items-center bg-white border rounded px-2 py-0.5">
                         <input type="number" min="1" value={segmentSeconds} onChange={(e) => setSegmentSeconds(parseInt(e.target.value)||1)} className="w-12 text-center text-sm outline-none font-bold text-blue-600" />
                         <span className="text-xs text-slate-400">s</span>
                       </div>
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div className="flex justify-center pt-4">
              <Button onClick={handleStartProcessing} disabled={status === AppStatus.PROCESSING || status === AppStatus.LOADING_CORE} className="px-12 py-3.5 text-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all w-full md:w-auto">
                {status === AppStatus.IDLE || status === AppStatus.ERROR || status === AppStatus.COMPLETED ? (
                  <><Play className="w-5 h-5 fill-current" /> Bắt đầu xử lý</>
                ) : 'Đang xử lý...'}
              </Button>
            </div>
          </div>

          {/* Logs */}
          <div className="bg-slate-900 text-slate-200 p-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-slate-400">
                <Terminal className="w-4 h-4"/> 
                <span className="text-xs font-mono uppercase tracking-wider">System Logs</span>
              </div>
              <span className="text-xs font-mono text-blue-400">{progress}% Completed</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 mb-4 overflow-hidden">
               <div className="bg-blue-500 h-full transition-all duration-300 ease-out shadow-[0_0_10px_rgba(59,130,246,0.5)]" style={{width: `${progress}%`}}></div>
            </div>
            <div className="h-48 overflow-y-auto font-mono text-xs space-y-1.5 pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
               {logs.length === 0 && <div className="text-slate-600 italic">Waiting for input...</div>}
               {logs.map(log => (
                 <div key={log.id} className={`flex gap-2 ${log.type === 'error' ? 'text-red-400' : log.type === 'success' ? 'text-green-400' : log.type === 'warning' ? 'text-yellow-400' : 'text-slate-300'}`}>
                   <span className="opacity-40 select-none">[{log.timestamp.toLocaleTimeString()}]</span> 
                   <span>{log.text}</span>
                 </div>
               ))}
               <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}