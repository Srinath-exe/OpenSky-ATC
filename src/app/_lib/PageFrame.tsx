'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LogoMark, cx } from '@/design';
import { applyPrefsToDocument } from './persist';
import s from './PageFrame.module.css';

export interface PageFrameProps {
  /** Route test id (05 §3.1 page root). */
  testId: string;
  /** Breadcrumb text right of the wordmark ("Settings"). */
  crumb?: React.ReactNode;
  /** Nav right-hand cluster. */
  right?: React.ReactNode;
  width?: 'wide' | 'narrow';
  brandTestId?: string;
  children: React.ReactNode;
}

/** Fixed nav + single internal scroll region (body never scrolls, A4). */
export function PageFrame({ testId, crumb, right, width = 'wide', brandTestId = 'nav-brand', children }: PageFrameProps) {
  const router = useRouter();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => { applyPrefsToDocument(); setReady(true); }, []);
  return (
    <div className={s.root} data-testid={testId} data-ready={ready ? 'true' : undefined}>
      <header className={s.nav}>
        <div className={s.left}>
          <button type="button" className={s.brand} data-testid={brandTestId} aria-label="SKYCONTROL home" onClick={() => router.push('/')}>
            <LogoMark size={28} />
            <span className={s.wordmark}>Skycontrol</span>
          </button>
          {crumb ? <span className={s.crumb}>{crumb}</span> : null}
        </div>
        <div className={s.right}>{right}</div>
      </header>
      <div className={s.scroll}>
        <div className={cx(s.inner, width === 'wide' ? s.wide : s.narrow)}>{children}</div>
      </div>
    </div>
  );
}

/** Wraps a design Toggle / Segmented so its button mirrors boolean state as `data-state="on|off"` (05 §3.1). */
export function StateMirror({ state, children, className }: { state: string; children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('button[role="switch"], button[data-testid]');
    if (el) el.setAttribute('data-state', state);
  });
  return <span ref={ref} className={cx(s.contents, className)}>{children}</span>;
}
