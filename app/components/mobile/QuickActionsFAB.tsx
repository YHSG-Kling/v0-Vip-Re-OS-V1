import React, { useState } from 'react';
import { Plus, Phone, PenTool, Camera, X } from 'lucide-react';

const QuickActionsFAB: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false);

    const actions = [
        { label: 'Photo Upload', icon: Camera, color: 'bg-purple-600' },
        { label: 'Add Note', icon: PenTool, color: 'bg-emerald-600' },
        { label: 'Log Call', icon: Phone, color: 'bg-blue-600' },
    ];

    return (
        <div className="fixed bottom-24 right-6 z-[200]">
            {isOpen && (
                <div className="flex flex-col items-end gap-3 mb-4 animate-fade-in-up">
                    {actions.map((action, i) => (
                        <div key={i} className="flex items-center gap-3 group">
                            <span className="bg-slate-900 text-white text-[9px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg shadow-xl opacity-0 group-hover:opacity-100 transition-opacity">
                                {action.label}
                            </span>
                            <button className={`w-12 h-12 ${action.color} text-white rounded-full shadow-2xl flex items-center justify-center active:scale-90 transition-transform`}>
                                <action.icon size={20} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <button 
                onClick={() => setIsOpen(!isOpen)}
                className={`w-16 h-16 rounded-full shadow-2xl flex items-center justify-center text-white transition-all active:scale-90 ${isOpen ? 'bg-slate-800 rotate-45' : 'bg-indigo-600'}`}
            >
                {isOpen ? <X size={28} /> : <Plus size={28} />}
            </button>
        </div>
    );
};

export default QuickActionsFAB;
