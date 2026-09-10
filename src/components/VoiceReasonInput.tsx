import { useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

export default function VoiceReasonInput({ value, onChange, label = "Reason", placeholder = "Reason type ya bolkar likho", required = false }: {
  value: string; onChange: (value: string) => void; label?: string; placeholder?: string; required?: boolean;
}) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const toggle = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      toast.error("Is browser mein voice typing supported nahi hai. Chrome use karein.");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "hi-IN";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = (e: any) => {
      setListening(false);
      toast.error(e?.error === "not-allowed" ? "Microphone permission allow karein" : "Voice clear nahi mili, dobara bolein");
    };
    recognition.onresult = (e: any) => {
      const spoken = String(e.results?.[0]?.[0]?.transcript || "").trim();
      if (spoken) onChange([value.trim(), spoken].filter(Boolean).join(" "));
    };
    recognitionRef.current = recognition;
    recognition.start();
  };

  return (
    <div className="space-y-1.5">
      <Label>{label}{required ? " *" : ""}</Label>
      <div className="flex gap-2">
        <Input className="h-11 flex-1" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        <Button type="button" variant={listening ? "destructive" : "outline"} className="h-11 shrink-0" onClick={toggle}>
          {listening ? <MicOff className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
          {listening ? "Roko" : "Bolkar likho"}
        </Button>
      </div>
      {listening && <p className="text-xs text-destructive">Sun raha hai… ab reason bolein</p>}
    </div>
  );
}
