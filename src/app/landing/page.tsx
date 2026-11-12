import type { Metadata } from 'next';
import Landing from './Landing';

export const metadata: Metadata = {
  title: 'Air traffic control at SFO',
  description: 'Work real traffic into San Francisco: vector it onto the ILS, clear it to land, taxi it in, push, taxi and launch the next one. In your browser, with your voice, with an AI controller on the other seat if you want one.',
};

export default function LandingPage() {
  return <Landing />;
}
