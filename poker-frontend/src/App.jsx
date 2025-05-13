import React from 'react';
import { Routes, Route } from 'react-router-dom';
import MainMenu from './components/MainMenu';
import PokerRoom from './components/PokerRoom';
import './App.css';

const WS_URL = import.meta.env.VITE_SERVER || 'ws://localhost:8080'

function App() {
  return (
    <div className="App">
      <h1>Poker Game</h1>
      <Routes>
        <Route path="/" element={<MainMenu wsUrl={WS_URL} />} />
        <Route path="/room/:roomId" element={<PokerRoom wsUrl={WS_URL} />} />
      </Routes>
    </div>
  );
}

export default App;