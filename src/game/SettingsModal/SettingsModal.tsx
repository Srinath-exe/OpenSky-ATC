'use client'
/* In-game settings (UX 04 §10 "settings-btn", G12 `settings-modal`): the tabbed settings (../Settings/SettingsTabs.tsx)
   that matter mid-shift, applied live through the store; your data and the credits live on the /settings page. */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import styles from './SettingsModal.module.css'
import { Modal, Button, Icon } from '@/design'
import { useShell } from '../shellContext'
import { SettingsTabs } from '../Settings/SettingsTabs'

export function SettingsModal() {
  const shell = useShell()
  const router = useRouter()
  const open = !!shell.open.settings
  const close = React.useCallback(() => shell.hide('settings'), [shell])
  return (
    <Modal open={open} onClose={close} title="Settings" showClose wide="xl" testId="settings-modal"
      footer={
        <div className={styles.foot}>
          <span className={styles.footHint}>Changes apply at once and are kept on this device.</span>
          <Button variant="secondary" size="sm" iconRight={<Icon name="external-link" size={14} />} onClick={() => { close(); router.push('/settings') }} testId="set-open-full">All settings</Button>
          <Button variant="primary" size="sm" onClick={close} testId="set-close">Done</Button>
        </div>
      }>
      <SettingsTabs variant="panel" onLeave={close} />
    </Modal>
  )
}
