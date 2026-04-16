import React, { useEffect } from 'react';
import { CheckCircle2, AlertCircle, X, Info } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface ToastProps {
  toasts: ToastMessage[];
  removeToast: (id: string) => void;
}

export const ToastContainer: React.FC<ToastProps> = ({ toasts, removeToast }) => {
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-3 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto min-w-[300px] max-w-md bg-white rounded-lg shadow-lg border border-slate-100 p-4 flex items-start gap-3 animate-slide-in-right transition-all"
        >
          <div className="mt-0.5">
            {toast.type === 'success' && <CheckCircle2 className="text-emerald-500" size={20} />}
            {toast.type === 'error' && <AlertCircle className="text-red-500" size={20} />}
            {toast.type === 'info' && <Info className="text-indigo-500" size={20} />}
          </div>
          <div className="flex-1">
            <h4 className={`text-sm font-bold capitalize ${
              toast.type === 'success' ? 'text-emerald-700' : 
              toast.type === 'error' ? 'text-red-700' : 'text-indigo-700'
            }`}>
              {toast.type}
            </h4>
            <p className="text-sm text-slate-600 mt-0.5 leading-snug">{toast.message}</p>
          </div>
          <button 
            onClick={() => removeToast(toast.id)}
            className="text-slate-400 hover:text-slate-600"
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
};
