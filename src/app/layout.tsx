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
  description: 'Be the controller at San Francisco International. Push back, taxi, clear for take-off and land them, by voice, in the browser.',
  applicationName: 'SKYCONTROL',
  metadataBase: new URL('https://openatc.aeon-labs.site'),
  openGraph: { type: 'website', siteName: 'SKYCONTROL', title: 'SKYCONTROL: air traffic control at SFO', description: 'Be the controller at San Francisco International. Push back, taxi, clear for take-off and land them, by voice, in the browser.', images: [{ url: '/og.jpg', width: 1200, height: 630, alt: 'SFO at night, terminal and parked aircraft' }] },
  twitter: { card: 'summary_large_image', title: 'SKYCONTROL: air traffic control at SFO', description: 'Be the controller at San Francisco International, by voice, in the browser.', images: ['/og.jpg'] },
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
