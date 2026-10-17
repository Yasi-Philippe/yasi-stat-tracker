import { Download, FileDown, Upload } from 'lucide-react';
import { useState } from 'react';
import { useSession, useVault } from '@/app/hooks';
import { session } from '@/app/session';
import { BackupError, createBackup, openBackup, readBackupHeader } from '@/core/io/backup';
import { exportCsv } from '@/core/io/csvExport';
import { todayISO } from '@/core/model/dates';
import { platform } from '@/platform';
import { confirm, Segmented, TextField } from '../components/Controls';
import { Sheet } from '../components/Sheet';
import { toast, toastError } from '../components/Toast';
import { fmtDay } from '../format';
import { Row } from './SettingsScreen';

export function BackupActions() {
  const s = useSession();
  const { vault } = useVault();
  const [restoring, setRestoring] = useState<{ bytes: Uint8Array; createdAt: string } | null>(null);

  const exportBackup = async () => {
    try {
      const material = await session.backupMaterial();
      if (!material) {
        toast('Backups need an account (the demo has no password to seal it with).', { kind: 'error' });
        return;
      }
      await vault.flush();
      const bytes = await createBackup(vault, material.envelope, material.email, material.dek);
      const saved = await platform().files.save(`trazo-backup-${todayISO()}.trazo`, 'application/octet-stream', bytes);
      if (saved) toast('Encrypted backup saved');
    } catch (err) {
      toastError(err);
    }
  };

  const pickBackup = async () => {
    const f = await platform().files.open(['.trazo', 'application/octet-stream', 'application/json']);
    if (!f) return;
    try {
      const head = readBackupHeader(f.bytes);
      setRestoring({ bytes: f.bytes, createdAt: head.createdAt });
    } catch (err) {
      toastError(err);
    }
  };

  const exportPlain = async () => {
    const ok = await confirm({
      title: 'Export unencrypted CSV?',
      body: 'This file contains your values in plain text. Anyone who gets it can read them. Use it to move data to another tool.',
      confirmLabel: 'Export CSV',
      danger: true,
    });
    if (!ok) return;
    await platform().files.save(`trazo-data-${todayISO()}.csv`, 'text/csv', `﻿${exportCsv(vault)}`);
  };

  return (
    <>
      <Row
        icon={<Download size={18} />}
        title="Export encrypted backup"
        sub={s.mode === 'demo' ? 'Needs an account.' : 'One sealed file, opened with your password or recovery key.'}
        onClick={() => void exportBackup()}
      />
      <Row icon={<Upload size={18} />} title="Restore from a backup" sub="Merges it in; newer edits win." onClick={() => void pickBackup()} />
      <Row icon={<FileDown size={18} />} title="Export as CSV" sub="Unencrypted, for spreadsheets." onClick={() => void exportPlain()} />
      <Sheet open={!!restoring} onClose={() => setRestoring(null)} title="Restore backup">
        {restoring && <RestoreForm bytes={restoring.bytes} createdAt={restoring.createdAt} onDone={() => setRestoring(null)} />}
      </Sheet>
    </>
  );
}

function RestoreForm({ bytes, createdAt, onDone }: { bytes: Uint8Array; createdAt: string; onDone: () => void }) {
  const { vault } = useVault();
  const [mode, setMode] = useState<'password' | 'recovery'>('password');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack-16"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const recs = await openBackup(bytes, mode === 'password' ? { password: secret } : { recoveryKey: secret });
          const changed = vault.importRecords(recs);
          toast(changed ? `Backup restored (${recs.length} records checked)` : 'Nothing new in that backup');
          onDone();
        } catch (err) {
          toastError(err instanceof BackupError ? err : err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="small muted">
        Made on {fmtDay(createdAt.slice(0, 10), 'medium')}. Use the password or recovery key that were valid <b>when it was made</b>.
      </p>
      <Segmented
        block
        value={mode}
        onChange={(m) => {
          setMode(m);
          setSecret('');
        }}
        options={[
          { value: 'password', label: 'Password' },
          { value: 'recovery', label: 'Recovery key' },
        ]}
      />
      <TextField label={mode === 'password' ? 'Password' : 'Recovery key'} type={mode === 'password' ? 'password' : 'text'} value={secret} onChange={setSecret} mono={mode === 'recovery'} autoFocus />
      <button className="btn primary lg block" disabled={!secret || busy}>
        {busy && <span className="spinner" />} Restore
      </button>
    </form>
  );
}
