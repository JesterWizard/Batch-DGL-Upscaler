import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type ImageRecord } from '../db';
import { upscaleImage, parseRestorationTime } from '../lib/gemini';
import { Play, Pause, AlertTriangle, Download, CheckCircle2, Loader2, Timer, Trash2, Plus, Key } from 'lucide-react';
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
          // If in Pro mode, try to get the selected key via env or window check
          keyToUse = process.env.API_KEY || null;
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
        if (waitTime) {
          setError(`API Limit Reached. Waiting for restoration...`);
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

  const clearAll = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm('DANGER: This will permanently delete ALL images in the list. Proceed?')) {
      // 1. Stop automation immediately
      automationRef.current = false;
      setIsAutomating(false);
      setRestorationTimer(null);
      setError(null);

      try {
        // 2. Clear the table and reset state
        await db.transaction('rw', db.images, async () => {
          await db.images.clear();
        });
        console.log('Batch cleared successfully');
      } catch (err) {
        console.error('Failed to clear batch:', err);
        // Fallback for extreme cases
        await db.images.toCollection().delete();
      }
    }
  };

  const stats = {
    total: images?.length || 0,
    completed: images?.filter(img => img.status === 'completed').length || 0,
    failed: images?.filter(img => img.status === 'failed').length || 0,
    pending: images?.filter(img => img.status === 'pending').length || 0,
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
          <p className="text-secondary font-mono text-xs">STATUS: {isAutomating ? 'ACTIVE_PROCESSING' : 'SYSTEM_IDLE'}</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full md:w-auto">
          <StatBox label="QUEUED" value={stats.pending} color="text-secondary" />
          <StatBox label="DONE" value={stats.completed} color="text-green-400" />
          <StatBox label="ERROR" value={stats.failed} color="text-red-400" />
          <StatBox label="TOTAL" value={stats.total} color="text-banana" />
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex bg-white/5 border border-white/10 p-1">
          <button
            onClick={() => setUseFreeKey(true)}
            className={cn(
              "px-4 py-2 font-mono text-[10px] transition-all",
              useFreeKey ? "bg-banana text-black font-bold" : "text-white/40 hover:text-white"
            )}
          >
            FREE_TIER
          </button>
          <button
            onClick={() => setUseFreeKey(false)}
            className={cn(
              "px-4 py-2 font-mono text-[10px] transition-all",
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
            className="flex items-center gap-2 px-6 py-3 border border-banana/50 text-banana hover:bg-banana/10 font-mono text-sm uppercase animate-pulse"
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
          onClick={clearAll} 
          className="flex items-center gap-2 p-3 text-secondary hover:text-red-400 transition-colors border border-transparent hover:border-red-900/50 hover:bg-red-900/10" 
          title="Clear Entire Batch"
        >
          <Trash2 size={20} />
          <span className="hidden md:inline font-mono text-[10px] uppercase">Clear All</span>
        </button>

        {restorationTimer !== null && (
          <div className="flex items-center gap-3 px-4 py-3 bg-red-950/30 border border-red-500/50 text-red-400 font-mono animate-pulse">
            <Timer size={18} />
            <span>WAITING FOR NANO BANANA RELOAD: {(restorationTimer / 1000).toFixed(0)}s</span>
          </div>
        )}
      </div>

      {/* Guide Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-2">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-sm uppercase text-white/40 tracking-widest">Automation Guide</h2>
            {upscaleGuide && (
              <span className="px-2 py-0.5 bg-banana/10 text-banana text-[10px] font-mono border border-banana/20">ACTIVE_GUIDE</span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 px-3 py-1.5 border border-white/10 hover:bg-white/5 cursor-pointer font-mono text-[10px] uppercase transition-all">
              <Plus size={12} />
              Upload SKILL.md
              <input type="file" accept=".md,.txt" className="hidden" onChange={handleGuideUpload} />
            </label>
            <button 
              onClick={() => setShowGuide(!showGuide)}
              className="text-secondary hover:text-white font-mono text-[10px] uppercase underline underline-offset-4"
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
              className="w-full h-40 bg-white/5 border border-white/10 p-4 font-mono text-xs text-secondary focus:outline-none focus:border-banana/50 transition-colors resize-none"
            />
          </motion.div>
        )}
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-20">
        <AnimatePresence>
          {images?.map((img) => (
            <motion.div
              key={img.id}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className={cn(
                "group relative bg-white/5 border border-white/10 overflow-hidden min-h-[300px] flex flex-col",
                img.status === 'processing' && "border-banana/50 ring-2 ring-banana/20",
                img.status === 'completed' && "border-green-500/30"
              )}
            >
              <div className="relative aspect-video overflow-hidden bg-black/40">
                <img 
                  src={img.upscaledUrl || img.originalUrl} 
                  alt={img.originalName} 
                  className={cn(
                    "w-full h-full object-cover transition-all duration-700",
                    img.status === 'processing' && "scale-110 saturate-150 blur-sm",
                  )}
                />
                
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60" />
                
                {img.status === 'processing' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
                    <Loader2 className="animate-spin text-banana mb-2" size={40} />
                    <span className="text-banana font-mono text-[10px] tracking-widest animate-pulse">UPSCALING_VIA_NANO</span>
                  </div>
                )}

                {img.status === 'completed' && (
                  <div className="absolute top-2 right-2">
                    <CheckCircle2 className="text-green-400 drop-shadow-lg" size={24} />
                  </div>
                )}
              </div>

              <div className="p-4 flex-1 flex flex-col justify-between space-y-4">
                <div>
                  <h3 className="font-mono text-xs truncate opacity-60 mb-1">{img.originalName}</h3>
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      img.status === 'pending' && "bg-secondary",
                      img.status === 'processing' && "bg-banana animate-ping",
                      img.status === 'completed' && "bg-green-400",
                      img.status === 'failed' && "bg-red-500",
                    )} />
                    <span className="text-[10px] font-mono uppercase tracking-wider">{img.status}</span>
                  </div>
                </div>

                {img.status === 'failed' && (
                  <div className="flex items-center gap-2 text-red-400 text-[10px] bg-red-900/20 p-2 border border-red-900/50">
                    <AlertTriangle size={12} />
                    <span className="truncate">{img.error}</span>
                  </div>
                )}

                {img.status === 'completed' && img.upscaledUrl && (
                  <button
                    onClick={() => downloadImage(img.upscaledUrl!, `upscaled_${img.originalName}`)}
                    className="flex items-center justify-center gap-2 w-full py-2 bg-white/10 hover:bg-banana hover:text-black transition-all text-[10px] font-bold uppercase"
                  >
                    <Download size={14} />
                    Download Upscaled
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

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
      <p className="text-[10px] font-mono text-secondary mb-1">{label}</p>
      <p className={cn("text-2xl font-mono font-bold", color)}>{value}</p>
    </div>
  );
}
