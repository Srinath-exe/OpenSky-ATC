import type { Metadata } from 'next';
import Landing from './landing/Landing';

// The front door is the film (landing/Landing.tsx); "Play" goes on to /start, where the shift is set up.
export const metadata: Metadata = {
  title: 'Air traffic control at SFO',
  description: 'Work real traffic into San Francisco: vector it onto the ILS, clear it to land, taxi it in, push, taxi and launch the next one. In your browser, with your voice, with an AI controller on the other seat if you want one.',
};

export default function Home() {
  return <Landing />;
}
