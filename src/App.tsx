/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import BatchManager from './components/BatchManager';

export default function App() {
  return (
    <main className="min-h-screen selection:bg-banana selection:text-black">
      <BatchManager />
      
      {/* Footer / Status Bar */}
      <footer className="fixed bottom-0 left-0 right-0 h-10 bg-black border-t border-white/5 flex items-center px-4 justify-between z-50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[10px] font-mono uppercase text-secondary">Endpoint_Healthy: europe-west1</span>
          </div>
          <div className="w-px h-4 bg-white/10" />
          <span className="text-[10px] font-mono uppercase text-secondary">Nano_Banana_Protocol: v2.5.0</span>
        </div>
        
        <div className="text-[10px] font-mono text-white/20 uppercase">
          &copy; 2026 AI Studio Build // Nano_Banana CI
        </div>
      </footer>
    </main>
  );
}

