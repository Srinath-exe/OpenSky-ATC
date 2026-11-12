'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, IconArrowLeft, IconPlay, cx } from '@/design';
import { PageFrame } from '../_lib/PageFrame';
import { useSessionRunning, sessionIcao } from '../_lib/persist';
import { SettingsTabs, VersionContext } from '@/game/Settings/SettingsTabs';
import pkg from '../../../package.json';
import s from './settings.module.css';

/* Settings, the full page: the same tabs as the in-game panel (game/Settings/SettingsTabs.tsx) plus your data and the
   credits, laid out across the width. */
export default function SettingsPage() {
  const router = useRouter();
  const running = useSessionRunning();
  const right = (
    <>
      {running ? (
        <Button variant="accent" iconLeft={<IconPlay size={16} />} onClick={() => router.push('/play')} testId="set-resume">Back to shift{sessionIcao() ? ` · ${sessionIcao()}` : ''}</Button>
      ) : null}
      <Button variant="secondary" iconLeft={<IconArrowLeft size={16} />} onClick={() => router.push('/start')} testId="set-back">Home</Button>
    </>
  );
  return (
    <PageFrame testId="page-settings" crumb="Settings" width="wide" brandTestId="set-home" right={right}>
      <div className={cx(s.page, 'ds-enter')}>
        <header className={s.head}>
          <h1 className={cx('title-l', s.title)}>Settings</h1>
          <p className={cx('body-s', s.sub)}>Changes apply immediately, also to a running shift, and are kept on this device.</p>
        </header>
        <VersionContext.Provider value={pkg.version}>
          <SettingsTabs variant="page" />
        </VersionContext.Provider>
      </div>
    </PageFrame>
  );
}
