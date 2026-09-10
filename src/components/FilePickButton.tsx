import { useRef, useState } from "react";
import type React from "react";

// Opening a file picker on a phone is fussier than it looks. Four separate
// things have broken this, each silently:
//
//   · A `display:none` input plus a programmatic `.click()` does nothing on
//     iOS Safari and inside a WebView, and raises nothing.
//
//   · A hidden input with `position:absolute` and no positioned parent
//     escapes to some other part of the page, so label association is the
//     only thing holding it together. The input now covers the button, so
//     the tap lands on the real <input type="file"> — the one element every
//     browser and WebView agrees to open a chooser for.
//
//   · Clearing `input.value` in the same tick as reading `files[0]` — done
//     so that picking the same file twice still fires — can invalidate the
//     File on Android before anything has read it. The reset now happens
//     after the handler has had the file, not before.
//
//   · When none of that worked there was no way to tell whether the pick had
//     even registered. The name of the chosen file appears immediately, so
//     "nothing happened" can be told apart from "it is working on it".

interface Props {
  onPick: (file: File) => void;
  accept?: string;
  /** Ask the camera for a fresh capture rather than the gallery. */
  capture?: boolean;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

export default function FilePickButton({
  onPick, accept = "image/*", capture = false, disabled = false, className = "", children,
}: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState("");

  return (
    <span className="inline-flex flex-col items-stretch gap-1">
      <span
        className={`relative inline-flex items-center justify-center gap-1.5 rounded-md
          text-sm font-medium transition-colors select-none
          ${disabled ? "opacity-50 pointer-events-none" : "cursor-pointer"} ${className}`}
      >
        {children}
        <input
          ref={ref}
          type="file"
          accept={accept}
          {...(capture ? { capture: "environment" as const } : {})}
          disabled={disabled}
          // Covers the button: zero opacity but laid out and hit-testable.
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          style={{ fontSize: 0 }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setPicked(`${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB`);
            onPick(f);
            // Only now, and out of band, so the File above stays readable.
            setTimeout(() => { if (ref.current) ref.current.value = ""; }, 0);
          }}
        />
      </span>
      {picked && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[220px]">
          picked: {picked}
        </span>
      )}
    </span>
  );
}
