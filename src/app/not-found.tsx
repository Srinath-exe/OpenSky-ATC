'use client';
import { useRouter } from 'next/navigation';
import { Button, EmptyState, Icon, IconArrowLeft, IconSettings } from '@/design';
import { PageFrame } from './_lib/PageFrame';
import s from './not-found.module.css';

export default function NotFound() {
  const router = useRouter();
  return (
    <PageFrame testId="page-not-found" crumb="Not found" width="narrow">
      <div className={s.wrap}>
      <EmptyState
        icon={<Icon name="compass" size={24} />}
        title="No such frequency"
        hint="The page you asked for is not on this airfield. Head back to the airport picker or check your settings."
        action={
          <span className={s.actions}>
            <Button variant="accent" iconLeft={<IconArrowLeft size={16} />} onClick={() => router.push('/')} testId="notfound-home">Back to home</Button>
            <Button variant="ghost" iconLeft={<IconSettings size={16} />} onClick={() => router.push('/settings')} testId="notfound-settings">Settings</Button>
          </span>
        }
        testId="not-found"
      />
      </div>
    </PageFrame>
  );
}
