import type { Metadata, Viewport } from 'next'
import { DM_Sans } from 'next/font/google'
import './globals.css'

/* A18: DM Sans variable (wght 100-1000 covers the 300/400/500 tokens) with the opsz axis; the metric fallback
   ("DM Sans Fallback") is declared in globals.css. next/font requires weight 'variable' when axes are requested. */
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: 'variable',
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-dm-sans',
  adjustFontFallback: false,
  fallback: ['DM Sans Fallback', 'Outfit', 'Helvetica Neue', 'Arial', 'sans-serif'],
})

export const metadata: Metadata = {
  title: { default: 'SKYCONTROL', template: '%s · SKYCONTROL' },
  description: 'Ground, tower and approach air traffic control at six real airports: push back, taxi, line up, vector, clear to land and handle emergencies.',
  applicationName: 'SKYCONTROL',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#0b0b0c',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body>{children}</body>
    </html>
  )
}
