import React, { useState, useRef } from 'react';
import { Mic, Square, Loader2, X, Bot, Sparkles, CheckCircle2, AlertCircle } from 'lucide-react';
import { n8nService } from '../../services/n8n';
import { useAuth } from '../../contexts/AuthContext';

export const VoiceCommandButton: React.FC = () => {
  const { user } = useAuth();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState<{success: boolean, message: string} | null>(null);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      
      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        const base64Audio = await blobToBase64(audioBlob);
        await processVoiceCommand(base64Audio);
        stream.getTracks().forEach(track => track.stop());
      };
      
      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);
      setResult(null);
    } catch (error) {
      alert('Microphone access denied or unavailable.');
    }
  };
  
  const stopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setIsRecording(false);
    }
  };
  
  const processVoiceCommand = async (audioBase64: string) => {
    setIsProcessing(true);
    try {
      const response = await n8nService.processVoiceCommand(user?.id || 'agent_1', audioBase64);
      if (response.success) {
        setTranscript(response.transcript || "Command received.");
        setResult({ success: true, message: response.actionTaken || "Command executed." });
        
        // Clear after delay
        setTimeout(() => {
          setTranscript('');
          setResult(null);
          setIsProcessing(false);
        }, 4000);
      } else {
        setResult({ success: false, message: "Could not resolve command intent." });
        setIsProcessing(false);
      }
    } catch (error) {
      setResult({ success: false, message: "Voice network error." });
      setIsProcessing(false);
    }
  };
  
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };
  
  return (
    <div className="fixed bottom-6 right-6 z-[300] flex flex-col items-end gap-3 pointer-events-none">
      {/* Visual Feedback Overlays */}
      {(isRecording || isProcessing || result || transcript) && (
        <div className="pointer-events-auto mb-4 w-full max-w-sm flex flex-col gap-2 animate-fade-in-up">
            {isRecording && (
                <div className="bg-red-600 text-white px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3 animate-pulse border-2 border-red-400">
                    <div className="w-2 h-2 rounded-full bg-white animate-ping" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-white">Listening Hands-Free...</span>
                </div>
            )}

            {isProcessing && !result && (
                <div className="bg-slate-900 text-white px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border-2 border-slate-700">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-white">AI Synthesis Engine Running...</span>
                </div>
            )}

            {transcript && (
                <div className="bg-white border-2 border-indigo-100 rounded-[1.5rem] p-5 shadow-2xl relative overflow-hidden">
                    <div className="absolute right-[-10px] top-[-10px] opacity-5 text-indigo-900"><Bot size={80}/></div>
                    <div className="relative z-10">
                        <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1 flex items-center gap-1.5"><Bot size={10}/> Transcript</p>
                        <p className="text-xs font-bold text-slate-700 italic">"{transcript}"</p>
                    </div>
                </div>
            )}

            {result && (
                <div className={`rounded-[1.5rem] p-5 shadow-2xl flex items-start gap-4 border-2 animate-bounce-subtle ${
                    result.success ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'
                }`}>
                    <div className="mt-1">
                        {result.success ? <CheckCircle2 size={18}/> : <AlertCircle size={18}/>}
                    </div>
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest mb-0.5">Execution Status</p>
                        <p className="text-xs font-bold">{result.message}</p>
                    </div>
                </div>
            )}
        </div>
      )}

      {/* Floating Main Button */}
      <div className="pointer-events-auto relative group">
          <button
            onClick={isRecording ? stopRecording : startRecording}
            disabled={isProcessing}
            className={`w-16 h-16 rounded-[1.5rem] shadow-[0_20px_50px_rgba(79,70,229,0.3)] flex items-center justify-center transition-all active:scale-90 border-4 border-white ${
              isRecording 
                ? 'bg-red-600 shadow-red-500/20' 
                : isProcessing
                ? 'bg-slate-400 scale-95 opacity-50'
                : 'bg-indigo-600 hover:bg-indigo-700 hover:shadow-indigo-500/40'
            }`}
          >
            {isProcessing ? (
              <Loader2 className="w-8 h-8 text-white animate-spin" />
            ) : isRecording ? (
              <Square className="w-6 h-6 text-white" />
            ) : (
              <Mic className="w-8 h-8 text-white" />
            )}
          </button>
          
          {!isRecording && !isProcessing && !result && (
              <div className="absolute right-full mr-4 top-1/2 -translate-y-1/2 bg-slate-900 text-white px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap shadow-xl flex items-center gap-2">
                  <Sparkles size={10} className="text-indigo-400"/> Speak Command
              </div>
          )}
      </div>

      <style>{`
        @keyframes bounce-subtle {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-5px); }
        }
        .animate-bounce-subtle { animation: bounce-subtle 2s ease-in-out infinite; }
      `}</style>
    </div>
  );
};
