import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type ImageRecord } from '../db';
import { upscaleImage, parseRestorationTime, formatDuration } from '../lib/gemini';
import { Play, Pause, AlertTriangle, Download, CheckCircle2, Loader2, Timer, Trash2, Plus, Key, Grid2X2, List } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

export default function BatchManager() {
  const images = useLiveQuery(() => db.images.orderBy('createdAt').toArray());
  const [isAutomating, setIsAutomating] = useState(false);
  const [restorationTimer, setRestorationTimer] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean>(false);
  const [useFreeKey, setUseFreeKey] = useState<boolean>(true);
  const [upscaleGuide, setUpscaleGuide] = useState<string>('');
  const [showGuide, setShowGuide] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const automationRef = useRef<boolean>(false);
  const useFreeKeyRef = useRef<boolean>(true);
  const guideRef = useRef<string>('');

  // Check for API key on mount and periodically
  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const has = await window.aistudio.hasSelectedApiKey();
        setHasApiKey(has);
      }
    };
    checkKey();
    const interval = setInterval(checkKey, 5000);
    return () => clearInterval(interval);
  }, []);

  // Sync refs with state
  useEffect(() => {
    automationRef.current = isAutomating;
    useFreeKeyRef.current = useFreeKey;
    guideRef.current = upscaleGuide;
    if (isAutomating) {
      processNextInQueue();
    }
  }, [isAutomating, useFreeKey, upscaleGuide]);

  // Handle restoration timer countdown
  useEffect(() => {
    if (restorationTimer === null) return;
    
    if (restorationTimer <= 0) {
      setRestorationTimer(null);
      if (automationRef.current) {
        processNextInQueue();
      }
      return;
    }

    const timer = setInterval(() => {
      setRestorationTimer(prev => (prev ? prev - 1000 : null));
    }, 1000);

    return () => clearInterval(timer);
  }, [restorationTimer]);

  const processNextInQueue = async () => {
    if (!automationRef.current || restorationTimer !== null) return;

    try {
      const next = await db.images
        .where('status')
        .equals('pending')
        .first();

      if (!next) {
        setIsAutomating(false);
        return;
      }

      await db.images.update(next.id!, { status: 'processing' });
      
      try {
        // Resolve key to use
        let keyToUse = null;
        if (!useFreeKeyRef.current) {
          // If in Pro mode, try to get the selected key via platform integration
          // @ts-ignore - aistudio might have getApiKey in some environments
          if (window.aistudio?.getApiKey) {
            // @ts-ignore
            keyToUse = await window.aistudio.getApiKey();
          }
        }

        const upscaledUrl = await upscaleImage(next.originalUrl, keyToUse, guideRef.current);
        await db.images.update(next.id!, { 
          status: 'completed', 
          upscaledUrl,
          completedAt: Date.now() 
        });
        
        // Auto-download logic
        downloadImage(upscaledUrl, `upscaled_${next.originalName}`);

        // Queue next one after a short breather
        if (automationRef.current) {
          setTimeout(processNextInQueue, 500);
        }
      } catch (err: any) {
        const waitTime = parseRestorationTime(err);
        if (waitTime !== null) {
          setError(`API limit reached. Estimated reset in ${formatDuration(waitTime)}.`);
          await db.images.update(next.id!, { status: 'pending' }); // Reset for retry
          setRestorationTimer(waitTime);
        } else if (err.message?.includes('403') || err.status === 403 || err.message?.includes('permission')) {
          setError(`Nano Banana access denied. Please select an API key.`);
          setIsAutomating(false);
          if (window.aistudio?.openSelectKey) {
            await window.aistudio.openSelectKey();
          }
        } else {
          console.error(err);
          await db.images.update(next.id!, { 
            status: 'failed', 
            error: err.message || 'Unknown error' 
          });
          // Continue with next one even if one fails
          if (automationRef.current) {
            setTimeout(processNextInQueue, 1000);
          }
        }
      }
    } catch (err) {
      console.error('Queue error:', err);
      setIsAutomating(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const records: ImageRecord[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();
      const url = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });

      records.push({
        originalName: file.name,
        originalUrl: url,
        status: 'pending',
        createdAt: Date.now() + i // Offset slightly for stable sort
      });
    }

    await db.images.bulkAdd(records);
  };

  const downloadImage = (url: string, filename: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadAll = () => {
    const completedImages = images?.filter(img => img.status === 'completed' && img.upscaledUrl) || [];
    completedImages.forEach(img => {
      downloadImage(img.upscaledUrl!, `upscaled_${img.originalName}`);
    });
  };

  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleGuideUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setUpscaleGuide(ev.target?.result as string);
      setShowGuide(true);
    };
    reader.readAsText(file);
  };

  const clearAll = async () => {
    // Stop automation immediately
    automationRef.current = false;
    setIsAutomating(false);
    setRestorationTimer(null);
    setError(null);
    setShowClearConfirm(false);

    try {
      // Clear the table forcefully
      await db.images.clear();
      console.log('Batch cleared successfully');
    } catch (err) {
      console.error('Failed to clear batch:', err);
      // Fallback for extreme cases
      try {
        await db.images.toCollection().delete();
      } catch (innerErr) {
        console.error('Final fallback failed:', innerErr);
      }
    }
  };

  const stats = {
    total: images?.length || 0,
    completed: images?.filter(img => img.status === 'completed').length || 0,
    failed: images?.filter(img => img.status === 'failed').length || 0,
    pending: images?.filter(img => img.status === 'pending').length || 0,
    processing: images?.filter(img => img.status === 'processing').length || 0,
  };
  const inputImages = images || [];
  const outputImages = inputImages.filter(img => img.upscaledUrl);

  const handleRetry = async (id: number) => {
    await db.images.update(id, {
      status: 'pending',
      error: undefined
    });
  };

  const handleSelectKey = async () => {
    if (window.aistudio?.openSelectKey) {
      setUseFreeKey(false);
      await window.aistudio.openSelectKey();
      const has = await window.aistudio.hasSelectedApiKey();
      setHasApiKey(has);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-8">
      {/* Header & Stats */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 bg-black/50 p-6 border-b border-banana/20">
        <div className="space-y-1">
          <h1 className="text-4xl font-mono font-bold tracking-tighter text-banana uppercase">
            Nano Banana
            <span className="text-white opacity-20 ml-2">Batch_Alpha_v1</span>
          </h1>
          <p className="text-secondary font-mono text-sm">STATUS: {isAutomating ? 'ACTIVE_PROCESSING' : 'SYSTEM_IDLE'}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full md:w-auto">
          <StatBox label="QUEUED" value={stats.pending} color="text-secondary" />
          <StatBox label="DONE" value={stats.completed} color="text-green-400" />
          <StatBox label="ERROR" value={stats.failed} color="text-red-400" />
          <StatBox label="TOTAL" value={stats.total} color="text-banana" />
        </div>
      </div>

      {/* Progress Bar Section */}
      {stats.total > 0 && (
        <div className="space-y-2">
          <div className="flex justify-between items-end font-mono text-[10px] uppercase tracking-widest text-white/40">
            <span>Pipeline_Progress</span>
            <span>{Math.round((stats.completed / stats.total) * 100)}%</span>
          </div>
          <div className="h-2 w-full bg-white/5 border border-white/10 flex overflow-hidden">
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${(stats.completed / stats.total) * 100}%` }}
              className="h-full bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.3)]"
            />
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${(stats.processing / stats.total) * 100}%` }}
              className="h-full bg-banana animate-pulse"
            />
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${(stats.failed / stats.total) * 100}%` }}
              className="h-full bg-red-500"
            />
          </div>
          <div className="flex gap-4 font-mono text-[9px] uppercase text-white/20">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
              <span>{stats.completed} Done</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-banana rounded-full animate-pulse" />
              <span>{stats.processing} Processing</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-red-500 rounded-full" />
              <span>{stats.failed} Failed</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-white/20 rounded-full" />
              <span>{stats.pending} Waiting</span>
            </div>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex bg-white/5 border border-white/10 p-1">
          <button
            onClick={() => setUseFreeKey(true)}
            className={cn(
              "px-4 py-2 font-mono text-xs transition-all",
              useFreeKey ? "bg-banana text-black font-bold" : "text-white/40 hover:text-white"
            )}
          >
            FREE_TIER
          </button>
          <button
            onClick={() => setUseFreeKey(false)}
            className={cn(
              "px-4 py-2 font-mono text-xs transition-all",
              !useFreeKey ? "bg-banana text-black font-bold" : "text-white/40 hover:text-white"
            )}
          >
            PRO_TIER
          </button>
        </div>

        <button
          onClick={() => setIsAutomating(!isAutomating)}
          className={cn(
            "flex items-center gap-2 px-8 py-3 bristol-button",
            isAutomating ? "bg-red-500 hover:bg-red-600" : "bg-banana"
          )}
        >
          {isAutomating ? <Pause size={20} /> : <Play size={20} />}
          {isAutomating ? "Stop Automation" : "Start Automation"}
        </button>

        {!useFreeKey && !hasApiKey && (
          <button
            onClick={handleSelectKey}
            className="flex items-center gap-2 px-6 py-3 border border-banana/50 text-banana hover:bg-banana/10 font-mono text-base uppercase animate-pulse"
          >
            <Key size={18} />
            Connect Pro Key
          </button>
        )}

        <label className="flex items-center gap-2 px-4 py-3 border border-white/10 hover:bg-white/5 cursor-pointer font-mono text-sm uppercase">
          <Plus size={18} />
          Add Images
          <input type="file" multiple accept="image/*" className="hidden" onChange={handleFileUpload} />
        </label>

        <button 
          onClick={downloadAll}
          disabled={stats.completed === 0}
          className={cn(
            "flex items-center gap-2 p-3 transition-colors border border-transparent",
            stats.completed > 0 
              ? "text-banana hover:border-banana/30 hover:bg-banana/10" 
              : "text-white/20 cursor-not-allowed"
          )}
          title="Download All Completed"
        >
          <Download size={20} />
          <span className="hidden md:inline font-mono text-xs uppercase">Download All ({stats.completed})</span>
        </button>

        {showClearConfirm ? (
          <div className="flex items-center gap-2 bg-red-900/20 border border-red-500/50 p-1">
            <span className="text-red-400 font-mono text-[10px] uppercase px-2">Confirm Delete?</span>
            <button 
              onClick={clearAll}
              className="bg-red-500 text-white px-3 py-1 font-mono text-xs uppercase font-bold hover:bg-red-600"
            >
              YES
            </button>
            <button 
              onClick={() => setShowClearConfirm(false)}
              className="bg-white/10 text-white px-3 py-1 font-mono text-xs uppercase hover:bg-white/20"
            >
              NO
            </button>
          </div>
        ) : (
          <button 
            onClick={() => setShowClearConfirm(true)} 
            className="flex items-center gap-2 p-3 text-secondary hover:text-red-400 transition-colors border border-transparent hover:border-red-900/50 hover:bg-red-900/10" 
            title="Clear Entire Batch"
          >
            <Trash2 size={20} />
            <span className="hidden md:inline font-mono text-xs uppercase">Clear All</span>
          </button>
        )}

        {restorationTimer !== null && (
          <div className="flex items-center gap-3 px-4 py-3 bg-red-950/30 border border-red-500/50 text-red-400 font-mono animate-pulse">
            <Timer size={18} />
            <span>WAITING FOR NANO BANANA RELOAD: {formatDuration(restorationTimer)}</span>
          </div>
        )}

        <div className="ml-auto flex bg-white/5 border border-white/10 p-1">
          <button
            onClick={() => setViewMode('grid')}
            className={cn(
              "flex items-center gap-2 px-4 py-2 font-mono text-xs transition-all uppercase",
              viewMode === 'grid' ? "bg-banana text-black font-bold" : "text-white/40 hover:text-white"
            )}
          >
            <Grid2X2 size={14} />
            Grid
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              "flex items-center gap-2 px-4 py-2 font-mono text-xs transition-all uppercase",
              viewMode === 'list' ? "bg-banana text-black font-bold" : "text-white/40 hover:text-white"
            )}
          >
            <List size={14} />
            List
          </button>
        </div>
      </div>

      {/* Guide Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-2">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-sm uppercase text-white/40 tracking-widest">Automation Guide</h2>
            {upscaleGuide && (
              <span className="px-2 py-0.5 bg-banana/10 text-banana text-xs font-mono border border-banana/20">ACTIVE_GUIDE</span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 px-3 py-1.5 border border-white/10 hover:bg-white/5 cursor-pointer font-mono text-xs uppercase transition-all">
              <Plus size={12} />
              Upload SKILL.md
              <input type="file" accept=".md,.txt" className="hidden" onChange={handleGuideUpload} />
            </label>
            <button 
              onClick={() => setShowGuide(!showGuide)}
              className="text-secondary hover:text-white font-mono text-xs uppercase underline underline-offset-4"
            >
              {showGuide ? "[Hide Editor]" : "[Manual Edit]"}
            </button>
          </div>
        </div>

        {showGuide && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            className="overflow-hidden"
          >
            <textarea
              value={upscaleGuide}
              onChange={(e) => setUpscaleGuide(e.target.value)}
              placeholder="# SKILL.md Guide
- Focus on texture preservation
- Enhance skin details
- Warm up the temperature slightly..."
              className="w-full h-40 bg-white/5 border border-white/10 p-4 font-mono text-sm text-secondary focus:outline-none focus:border-banana/50 transition-colors resize-none"
            />
          </motion.div>
        )}
      </div>

      {inputImages.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-10 pb-20 items-start">
          <ImageSection
            title="Input Images"
            badge={`${inputImages.length}_QUEUED`}
            images={inputImages}
            viewMode={viewMode}
            imageSource="original"
            onRetry={handleRetry}
          />

          <ImageSection
            title="Output Images"
            badge={`${outputImages.length}_RENDERED`}
            images={outputImages}
            viewMode={viewMode}
            imageSource="upscaled"
            onDownload={downloadImage}
            onRetry={handleRetry}
          />
        </div>
      )}

      {images?.length === 0 && (
        <div className="flex flex-col items-center justify-center py-40 border-2 border-dashed border-white/5 rounded-2xl">
          <div className="w-20 h-20 bg-banana/10 rounded-full flex items-center justify-center mb-6">
            <Plus className="text-banana" size={40} />
          </div>
          <p className="text-secondary font-mono">NO DATA IN PIPELINE. ADD IMAGES TO BEGIN.</p>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white/5 border border-white/5 p-4 min-w-[100px]">
      <p className="text-xs font-mono text-secondary mb-1">{label}</p>
      <p className={cn("text-2xl font-mono font-bold", color)}>{value}</p>
    </div>
  );
}

interface ImageSectionProps {
  title: string;
  badge: string;
  images: ImageRecord[];
  viewMode: 'grid' | 'list';
  imageSource: 'original' | 'upscaled';
  onDownload?: (url: string, filename: string) => void;
  onRetry?: (id: number) => void;
}

function ImageSection({
  title,
  badge,
  images,
  viewMode,
  imageSource,
  onDownload,
  onRetry,
}: ImageSectionProps) {
  if (images.length === 0) {
    return (
      <section className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-2">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-sm uppercase text-white/60 tracking-widest">{title}</h2>
            <span className="px-2 py-0.5 bg-white/5 text-secondary text-xs font-mono border border-white/10">{badge}</span>
          </div>
        </div>
        <div className="border border-dashed border-white/10 p-8 text-center font-mono text-sm text-secondary">
          NO IMAGES IN THIS VIEW.
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between border-b border-white/10 pb-2">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-sm uppercase text-white/60 tracking-widest">{title}</h2>
          <span className="px-2 py-0.5 bg-white/5 text-secondary text-xs font-mono border border-white/10">{badge}</span>
        </div>
      </div>

      <div className={cn(
        viewMode === 'grid'
          ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
          : "flex flex-col gap-4"
      )}>
        <AnimatePresence>
          {images.map((img) => (
            <ImageCard
              key={`${imageSource}-${img.id}`}
              img={img}
              viewMode={viewMode}
              imageSource={imageSource}
              onDownload={onDownload}
              onRetry={onRetry}
            />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

interface ImageCardProps {
  key?: string | number;
  img: ImageRecord;
  viewMode: 'grid' | 'list';
  imageSource: 'original' | 'upscaled';
  onDownload?: (url: string, filename: string) => void;
  onRetry?: (id: number) => void;
}

function ImageCard({
  img,
  viewMode,
  imageSource,
  onDownload,
  onRetry,
}: ImageCardProps) {
  const [comparePosition, setComparePosition] = useState(50);
  const imageUrl = imageSource === 'upscaled' && img.upscaledUrl ? img.upscaledUrl : img.originalUrl;
  const isList = viewMode === 'list';
  const showCompareSlider = !isList && imageSource === 'upscaled' && !!img.upscaledUrl;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className={cn(
        "group relative bg-white/5 border border-white/10 overflow-hidden",
        isList ? "flex items-center justify-between gap-4 p-4 min-h-[72px]" : "flex flex-col",
        img.status === 'processing' && "border-banana/50 ring-2 ring-banana/20",
        img.status === 'completed' && "border-green-500/30"
      )}
    >
      {!isList && (
        <div className="relative aspect-video overflow-hidden bg-black/40">
          {showCompareSlider ? (
            <>
              <img
                src={img.originalUrl}
                alt={`${img.originalName} before`}
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}
              >
                <img
                  src={img.upscaledUrl}
                  alt={`${img.originalName} after`}
                  className="absolute inset-0 w-full h-full object-cover"
                />
              </div>
              <div
                className="absolute inset-y-0 w-0.5 bg-white/90 shadow-[0_0_12px_rgba(255,255,255,0.6)]"
                style={{ left: `calc(${comparePosition}% - 1px)` }}
              />
              <div className="absolute inset-x-0 top-2 flex items-center justify-between px-3 text-xs font-mono uppercase tracking-wider text-white">
                <span className="bg-black/55 px-2 py-1">Before</span>
                <span className="bg-black/55 px-2 py-1">After</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={comparePosition}
                onChange={(e) => setComparePosition(Number(e.target.value))}
                className="absolute inset-x-3 bottom-3 accent-banana"
                aria-label={`Compare original and upscaled versions of ${img.originalName}`}
              />
            </>
          ) : (
            <img
              src={imageUrl}
              alt={img.originalName}
              className={cn(
                "w-full h-full object-cover transition-all duration-700",
                img.status === 'processing' && "scale-110 saturate-150 blur-sm",
              )}
            />
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60" />

          {img.status === 'processing' && imageSource === 'original' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
              <Loader2 className="animate-spin text-banana mb-2" size={40} />
              <span className="text-banana font-mono text-xs tracking-widest animate-pulse">UPSCALING_VIA_NANO</span>
            </div>
          )}

          {img.status === 'completed' && (
            <div className="absolute top-2 right-2">
              <CheckCircle2 className="text-green-400 drop-shadow-lg" size={24} />
            </div>
          )}
        </div>
      )}

      <div className={cn(
        "flex-1",
        isList ? "min-w-0" : "p-4 flex flex-col justify-between space-y-4"
      )}>
        <div>
          <h3 className="font-mono text-xl truncate text-white mb-1 tracking-tight">{img.originalName}</h3>
          <div className="flex items-center gap-2">
            <div className={cn(
              "w-1.5 h-1.5 rounded-full",
              img.status === 'pending' && "bg-secondary/40",
              img.status === 'processing' && "bg-banana animate-ping",
              img.status === 'completed' && "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]",
              img.status === 'failed' && "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]",
            )} />
            <span className={cn(
              "text-[10px] font-mono uppercase tracking-widest",
              img.status === 'failed' ? "text-red-400" : "text-white/40"
            )}>
              {img.status}
            </span>
          </div>
        </div>

        {!isList && img.status === 'failed' && (
          <div className="flex flex-col gap-2 p-3 bg-red-950/40 border border-red-500/30 rounded">
            <div className="flex items-start gap-2 text-red-100/90 text-[11px] font-mono leading-relaxed">
              <AlertTriangle className="shrink-0 text-red-400 mt-0.5" size={14} />
              <p className="break-words font-medium">ERROR_LOG: {img.error || 'UNSPECIFIED_FAILURE'}</p>
            </div>
            
            {onRetry && (
              <button
                onClick={() => onRetry(img.id!)}
                className="flex items-center justify-center gap-2 w-full py-1.5 bg-red-500/20 hover:bg-red-500/40 text-red-100 border border-red-500/50 transition-all text-[10px] font-mono uppercase font-bold"
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                >
                  <Loader2 size={12} />
                </motion.div>
                Retry Processing
              </button>
            )}
          </div>
        )}

        {!isList && imageSource === 'upscaled' && img.upscaledUrl && onDownload && (
          <button
            onClick={() => onDownload(img.upscaledUrl!, `upscaled_${img.originalName}`)}
            className="flex items-center justify-center gap-2 w-full py-2 bg-white/10 hover:bg-banana hover:text-black transition-all text-xs font-bold uppercase"
          >
            <Download size={14} />
            Download Upscaled
          </button>
        )}
      </div>

      {isList && img.status === 'completed' && (
        <CheckCircle2 className="text-green-400 shrink-0" size={18} />
      )}

      {isList && img.status === 'failed' && (
        <div className="flex items-center gap-3">
          <div className="hidden md:block max-w-[200px] truncate text-[10px] font-mono text-red-400 bg-red-950/30 px-2 py-1 border border-red-900/40">
            {img.error}
          </div>
          {onRetry && (
            <button
              onClick={() => onRetry(img.id!)}
              className="p-1.5 hover:bg-red-500/20 text-red-400 transition-colors"
              title="Retry"
            >
              <Loader2 size={16} />
            </button>
          )}
          <AlertTriangle className="text-red-400 shrink-0" size={18} />
        </div>
      )}

      {isList && img.status === 'processing' && imageSource === 'original' && (
        <Loader2 className="animate-spin text-banana shrink-0" size={18} />
      )}
    </motion.div>
  );
}
