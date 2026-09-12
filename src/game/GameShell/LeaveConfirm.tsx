'use client'
/* "Leave the shift?" confirm behind the brand link and the pause menu's Quit (UX 04 §10 brand-home, G12 home-leave-confirm-*). */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Modal, Button } from '@/design'
import { sim, useSim } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'
import { formatSimClock } from '../hooks/useSimSelector'

export function LeaveConfirm() {
  const shell = useShell()
  const router = useRouter()
  const open = !!shell.open.leaveConfirm
  const score = useSim((s) => s.score())
  const time = useSim((s) => Math.floor(s.time()))
  const leave = () => {
    shell.hide('leaveConfirm')
    sim.stop()
    router.push('/')
  }
  return (
    <Modal
      open={open}
      onClose={() => shell.hide('leaveConfirm')}
      title="Leave the shift?"
      testId="home-leave-confirm"
      footer={
        <>
          <Button variant="ghost" onClick={() => shell.hide('leaveConfirm')} testId="home-leave-confirm-no">Stay</Button>
          <Button variant="danger" onClick={leave} testId="home-leave-confirm-yes">Leave</Button>
        </>
      }
    >
      <p className="body-m">Your session ({formatSimClock(time)}, {score} points) is recorded in the shift history when you start the next one. Traffic keeps running until you leave.</p>
    </Modal>
  )
}
