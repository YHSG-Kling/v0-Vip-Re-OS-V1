import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from "@google/genai";
import { MessageSquare, Mic, Map, Globe, X, Send, Bot, Loader2, Sparkles, Zap, DollarSign, ArrowRight, Calendar, Copy, Info } from 'lucide-react';
import { n8nService } from '../../services/n8n';
import { useAuth } from '../../contexts/AuthContext';
import { UserRole } from '../../types';

interface Message {
  role: 'user' | 'model';
  text: string;
  sources?: { title: string; uri: string }[];
  isThinking?: boolean;
  action?: {
    type: 'lender_referral' | 'schedule_slot' | 'playbook_jump';
    label: string;
    data: any;
  };
}

function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  const uint8 = new Uint8Array(int16.buffer);
  let binary = '';
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  const base64Data = btoa(binary);

  return {
    data: base64Data,
    mimeType: 'audio/pcm;rate=16000',
  };
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

const SmartGuide: React.FC = () => {
  const { role, user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [showPrompt, setShowPrompt] = useState(true);
  const [mode, setMode] = useState<'chat' | 'live'>('chat');
  const [chatModel, setChatModel] = useState<'expert' | 'fast' | 'web' | 'maps'>('expert');
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', text: `Hello! I am your Smart Guide. I'm currently tracking your ${role === UserRole.BUYER ? 'Home Purchase' : role === UserRole.SELLER ? 'Listing Sale' : 'Database'} progress. How can I assist you right now?` }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setShowPrompt(false), 8000);
    return () => clearTimeout(timer);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || !process.env.API_KEY) return;
    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsLoading(true);

    try {
      // Create a new GoogleGenAI instance right before making an API call to ensure it always uses the most up-to-date API key.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      // Following guidelines for model naming and selection.
      let modelName = chatModel === 'expert' ? 'gemini-3-pro-preview' : 'gemini-flash-lite-latest';
      
      const result = await ai.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: userMsg }] }],
        config: {
            systemInstruction: `You are the Smart Guide, an advanced real estate concierge for the Nexus OS. 
            User Role: ${role}. 
            User Email: ${user?.email}.
            The user is currently viewing their home journey portal. 
            If they ask about their progress, remind them of their active playbook steps.
            Always be helpful, professional, and data-driven.`
        }
      });
      
      // The generated text output is accessed via the .text property
      setMessages(prev => [...prev, { role: 'model', text: result.text || "I'm processing that request." }]);
    } catch (error) {
      setMessages(prev => [...prev, { role: 'model', text: 'Connection error. Please try again.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const startLiveSession = async () => {
    if (!process.env.API_KEY) return;
    setIsLiveConnected(true);
    // Create a new GoogleGenAI instance right before making an API call to ensure it always uses the most up-to-date API key.
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    inputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      callbacks: {
        onopen: () => {
            const source = inputContextRef.current!.createMediaStreamSource(stream);
            const processor = inputContextRef.current!.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const blob = createBlob(e.inputBuffer.getChannelData(0));
              sessionPromiseRef.current?.then(s => s.sendRealtimeInput({ media: blob }));
            };
            source.connect(processor);
            processor.connect(inputContextRef.current!.destination);
        },
        onmessage: async (msg: LiveServerMessage) => {
          // Playback audio - decoding raw PCM bytes from modelTurn parts
          const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audioData && audioContextRef.current) {
            const binary = decode(audioData);
            const float32 = new Float32Array(binary.length / 2);
            const dataView = new DataView(binary.buffer);
            for (let i = 0; i < binary.length / 2; i++) float32[i] = dataView.getInt16(i * 2, true) / 32768;
            const buffer = audioContextRef.current.createBuffer(1, float32.length, 24000);
            buffer.getChannelData(0).set(float32);
            const source = audioContextRef.current.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContextRef.current.destination);
            // Gapless scheduling using running timestamp
            source.start(Math.max(audioContextRef.current.currentTime, nextStartTimeRef.current));
            nextStartTimeRef.current = Math.max(audioContextRef.current.currentTime, nextStartTimeRef.current) + buffer.duration;
          }
        },
        onclose: () => setIsLiveConnected(false),
        onerror: () => setIsLiveConnected(false)
      },
      config: { responseModalities: [Modality.AUDIO] }
    });
    sessionPromiseRef.current = sessionPromise;
  };

  return (
    <>
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col items-end gap-3">
        {showPrompt && !isOpen && (
            <div className="bg-white px-4 py-2.5 rounded-2xl shadow-xl border border-slate-200 animate-slide-in-right flex items-center gap-3 mb-2 max-w-xs">
                <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white shrink-0"><Sparkles size={16}/></div>
                <p className="text-xs font-bold text-slate-700">Hi! I'm the Smart Guide. Need help with your {role === UserRole.BUYER ? 'purchase' : 'listing'} steps?</p>
                <button onClick={() => setShowPrompt(false)} className="text-slate-300 hover:text-slate-500"><X size={14}/></button>
            </div>
        )}
        <button 
          onClick={() => { setIsOpen(!isOpen); setShowPrompt(false); }} 
          className={`h-16 w-16 bg-indigo-600 rounded-3xl shadow-2xl flex items-center justify-center text-white hover:scale-110 active:scale-95 transition-all border-4 border-white ${isOpen ? 'rotate-90' : ''}`}
        >
          {isOpen ? <X size={28} /> : <Sparkles size={28} />}
        </button>
      </div>

      {isOpen && (
        <div className="fixed bottom-28 right-6 w-[400px] h-[650px] bg-white rounded-[2.5rem] shadow-[0_30px_100px_rgba(0,0,0,0.4)] border border-slate-200 flex flex-col z-[100] overflow-hidden animate-scale-in">
          <div className="bg-slate-900 text-white p-6 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-50 rounded-2xl flex items-center justify-center font-black text-white shadow-lg"><Bot size={20} /></div>
              <div>
                <h3 className="font-black text-sm uppercase tracking-widest">Smart Guide</h3>
                <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-widest">Nexus Concierge • Active</p>
              </div>
            </div>
            <div className="flex bg-slate-800 rounded-xl p-1">
              <button onClick={() => setMode('chat')} className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${mode === 'chat' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>Chat</button>
              <button onClick={() => setMode('live')} className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${mode === 'live' ? 'bg-red-500 text-white' : 'text-slate-400 hover:text-white'}`}>Voice</button>
            </div>
          </div>

          {mode === 'chat' ? (
            <div className="flex-1 flex flex-col bg-slate-50">
              <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-hide">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div className={`max-w-[85%] rounded-[1.5rem] p-4 text-sm font-medium leading-relaxed shadow-sm ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-none'}`}>
                      {msg.text}
                    </div>
                  </div>
                ))}
                {isLoading && (
                    <div className="flex items-center gap-2 text-[10px] text-slate-400 font-black uppercase ml-2">
                        <Loader2 size={12} className="animate-spin" /> Analyzing Journey...
                    </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="p-4 bg-white border-t border-slate-100 flex gap-2">
                <input 
                    value={input} 
                    onChange={e => setInput(e.target.value)} 
                    onKeyDown={e => e.key === 'Enter' && handleSend()} 
                    placeholder="Ask about your next step..." 
                    className="flex-1 bg-slate-100 border-none rounded-2xl px-5 py-4 text-xs font-bold focus:ring-2 focus:ring-indigo-500 transition-all outline-none" 
                />
                <button onClick={handleSend} className="bg-indigo-600 text-white p-4 rounded-2xl hover:bg-indigo-700 shadow-lg active:scale-95 transition-all"><Send size={20} /></button>
              </div>
            </div>
          ) : (
            <div className="flex-1 bg-slate-900 text-white flex flex-col items-center justify-center p-12 text-center relative overflow-hidden">
                {isLiveConnected && <div className="absolute inset-0 flex items-center justify-center opacity-30"><div className="w-80 h-80 bg-indigo-500 rounded-full blur-3xl animate-pulse" /></div>}
                <div className={`w-28 h-28 rounded-[2.5rem] flex items-center justify-center transition-all duration-700 mb-8 ${isLiveConnected ? 'bg-red-500 shadow-[0_0_60px_rgba(239,68,68,0.5)] rotate-12' : 'bg-slate-800'}`}><Mic size={48} className={isLiveConnected ? 'animate-bounce' : 'text-slate-500'} /></div>
                <h3 className="text-2xl font-black italic uppercase tracking-tighter mb-4">{isLiveConnected ? 'Listening...' : 'Voice Guide'}</h3>
                <p className="text-slate-400 text-sm mb-12 font-medium">Have a voice conversation about your transaction milestones or market trends.</p>
                <button onClick={isLiveConnected ? () => setIsLiveConnected(false) : startLiveSession} className={`px-10 py-4 rounded-2xl font-black uppercase text-xs tracking-widest transition-all ${isLiveConnected ? 'bg-slate-800 hover:bg-slate-700 border border-slate-700' : 'bg-indigo-600 hover:bg-indigo-500 shadow-2xl shadow-indigo-500/20'}`}>{isLiveConnected ? 'Stop Session' : 'Begin Speech'}</button>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default SmartGuide;
