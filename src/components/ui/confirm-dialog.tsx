"use client";
import { useState } from "react";
import { Modal } from "./modal";
import { Button } from "./button";

interface Props {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, description, confirmLabel, destructive, onConfirm, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-taupe">{description}</p>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant={destructive ? "danger" : "primary"} onClick={run} loading={busy}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
