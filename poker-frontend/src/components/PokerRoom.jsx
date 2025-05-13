import React, { useState, useEffect, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { CSSTransition, TransitionGroup } from 'react-transition-group';
import '../PokerRoom.css';

const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK_SYMBOLS = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
const BIG_BLIND_AMOUNT_CONST = 20;


const SOUND_FILES = {
  DEAL_CARD: '/sounds/deal_card.mp3',
  PLAYER_ACTION: '/sounds/player_action.mp3', 
  FOLD: '/sounds/fold.mp3',
  YOUR_TURN: '/sounds/your_turn.mp3',
  WIN_POT: '/sounds/win_pot.mp3',
};

const playSound = (soundFile) => {
  try {
    const audio = new Audio(soundFile);
    audio.play().catch(e => console.warn("Audio play failed (user interaction may be required):", e));
  } catch (e) {
    console.error("Failed to initialize or play sound:", e);
  }
};


function PokerRoom({ wsUrl }) {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [currentMyClientId, setCurrentMyClientId] = useState(null);
  const [currentMyNickname, setCurrentMyNickname] = useState(location.state?.nickname || '');
  
  const [gameState, setGameState] = useState(null);
  const [betAmount, setBetAmount] = useState('');
  const [playersInLobby, setPlayersInLobby] = useState([]);
  const [error, setError] = useState('');
  const ws = useRef(null);
  const nodeRefs = useRef({}); 

  const prevGameStateRef = useRef(null);
  const prevIsMyTurnRef = useRef(false);

  useEffect(() => {
    let initialNickname = location.state?.nickname || localStorage.getItem(`pokerNickname_${roomId}`);
    if (!initialNickname) {
      initialNickname = `Player${Math.floor(Math.random() * 1000)}`;
    }
    setCurrentMyNickname(initialNickname);
    localStorage.setItem(`pokerNickname_${roomId}`, initialNickname);

    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      ws.current.send(JSON.stringify({ type: 'JOIN_ROOM', payload: { roomId, nickname: initialNickname } }));
    };

    ws.current.onmessage = (event) => {
      const parsedMessage = JSON.parse(event.data);
      switch (parsedMessage.type) {
        case 'JOINED_ROOM':
          setCurrentMyClientId(parsedMessage.payload.clientId);
          setCurrentMyNickname(parsedMessage.payload.nickname);
          localStorage.setItem(`pokerNickname_${roomId}`, parsedMessage.payload.nickname);
          setPlayersInLobby(parsedMessage.payload.players || []);
          break;
        case 'PLAYER_JOINED':
          setPlayersInLobby(parsedMessage.payload.players || []);
          break;
        case 'PLAYER_LEFT':
          setPlayersInLobby(parsedMessage.payload.players || []);
          break;
        case 'GAME_STATE_UPDATE':
          setGameState(parsedMessage.payload);
          setError('');
          break;
        case 'GAME_ERROR':
          setError(parsedMessage.payload);
          break;
        case 'ROOM_CLOSED':
          alert(parsedMessage.payload.message || 'Room has been closed.');
          localStorage.removeItem(`pokerNickname_${roomId}`);
          navigate('/');
          break;
        default:
          break;
      }
    };
    
    ws.current.onclose = () => {
        setError('Disconnected from server. Attempting to redirect...');
        setTimeout(() => {
            localStorage.removeItem(`pokerNickname_${roomId}`);
            navigate('/');
        }, 3000);
    };
    ws.current.onerror = () => setError('WebSocket connection error.');

    return () => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) ws.current.close();
    };
  }, [wsUrl, roomId, navigate, location.state?.nickname]);


  const myPlayerGameState = gameState && currentMyClientId && gameState.playerMap ? gameState.playerMap[currentMyClientId] : null;
  const isMyTurn = gameState && currentMyClientId && gameState.actionTo === currentMyClientId;

  useEffect(() => {
    if (prevGameStateRef.current && gameState) {
      const prevGs = prevGameStateRef.current;

      if (gameState.communityCards.length > prevGs.communityCards.length) {
        playSound(SOUND_FILES.DEAL_CARD);
      }
      if (myPlayerGameState && (!prevGs.playerMap || !prevGs.playerMap[currentMyClientId] || myPlayerGameState.hand.join('') !== prevGs.playerMap[currentMyClientId]?.hand.join('')) && myPlayerGameState.hand.every(c => c !== '?')) {
         if (myPlayerGameState.hand.length > 0 && (prevGs.playerMap && prevGs.playerMap[currentMyClientId]?.hand.every(c => c === '?'))) {
            playSound(SOUND_FILES.DEAL_CARD); 
         }
      }


      if (gameState.lastAction !== prevGs.lastAction && gameState.lastAction) {
        const la = gameState.lastAction.toLowerCase();
        if (la.includes('fold')) playSound(SOUND_FILES.FOLD);
        else if (la.includes('check') || la.includes('call') || la.includes('bet') || la.includes('raise')) {
          playSound(SOUND_FILES.PLAYER_ACTION);
        }
        if (la.includes('wins') && gameState.phase === 'showdown') playSound(SOUND_FILES.WIN_POT);
      }
    }
    
    if (isMyTurn && !prevIsMyTurnRef.current && gameState && 
        gameState.phase !== 'showdown' && 
        gameState.phase !== 'waiting_for_players' && 
        gameState.phase !== 'game_over') {
      playSound(SOUND_FILES.YOUR_TURN);
    }

    prevGameStateRef.current = JSON.parse(JSON.stringify(gameState)); 
    prevIsMyTurnRef.current = isMyTurn;
  }, [gameState, isMyTurn, currentMyClientId, myPlayerGameState]);


  const sendGameAction = (actionType, amount = null) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      const action = { type: actionType };
      if (amount !== null && !isNaN(parseInt(amount))) action.amount = parseInt(amount);
      ws.current.send(JSON.stringify({ type: 'GAME_ACTION', payload: { action } }));
      setBetAmount('');
    }
  };

  const handleStartGame = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'START_GAME' }));
  };
  
  const handleRequestNextHand = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'REQUEST_NEXT_HAND' }));
  };

  const renderCard = (cardStr, keySuffix) => {
    const uniqueKey = (cardStr || "placeholder") + keySuffix;
    if (!nodeRefs.current[uniqueKey]) {
        nodeRefs.current[uniqueKey] = React.createRef();
    }

    if (!cardStr || cardStr === "?" || cardStr === "FOLDED") {
      return <span ref={nodeRefs.current[uniqueKey]} className={`card unknown ${cardStr === "FOLDED" ? "folded-text-card" : ""}`}>{cardStr === "FOLDED" ? "FOLDED" : "?"}</span>;
    }
    const rank = RANK_SYMBOLS[cardStr.charAt(0)] || cardStr.charAt(0);
    const suit = SUIT_SYMBOLS[cardStr.charAt(1)];
    const colorClass = (suit === '♥' || suit === '♦') ? 'red-card' : 'black-card';
    return (
      <span ref={nodeRefs.current[uniqueKey]} className={`card ${colorClass}`}>
        {rank}{suit}
      </span>
    );
  };

  if (!currentMyClientId && !error) {
    return <div><h2>Poker Room: {roomId}</h2><p>Your Nickname: {currentMyNickname}</p><p>Connecting...</p></div>;
  }

  if (!gameState) {
    return (
        <div>
            <h2>Poker Room: {roomId}</h2>
            <p>Your Nickname: {currentMyNickname} (ID: {currentMyClientId || 'Assigning...'})</p>
            <p>Waiting for game state or other players...</p>
            {playersInLobby.length > 0 && (<div><h3>Players in Lobby:</h3><ul>{playersInLobby.map(p => <li key={p.id}>{p.nickname} {p.id === currentMyClientId ? '(You)' : ''}</li>)}</ul></div>)}
            {currentMyClientId && playersInLobby.length >= 1 && (<button onClick={handleStartGame}>Start Game</button>)}
            {error && <p className="error-message">{error}</p>}
        </div>
    );
  }

  const { phase, pot, communityCards, lastAction, actionTo, playerMap, currentBet, winners } = gameState;
  const amountToCall = myPlayerGameState ? currentBet - myPlayerGameState.betInRound : 0;
  const canCheck = myPlayerGameState && myPlayerGameState.betInRound === currentBet;
  const minBetRaiseAmount = currentBet > 0 ? (currentBet - (myPlayerGameState?.betInRound || 0)) + (gameState.minRaise || BIG_BLIND_AMOUNT_CONST) : (gameState.minRaise || BIG_BLIND_AMOUNT_CONST);

  return (
    <div className="poker-room">
      <h2>Room: {roomId}</h2>
      <p>Your Nickname: {myPlayerGameState?.nickname || currentMyNickname} </p>

      <div className="game-info-panel">
        <h3>Game Information</h3>
        <p>Phase: {phase} | Pot: {pot} | Bet to Match: {currentBet}</p>
        <div className="community-cards-area">
          <h4>Community Cards:</h4>
          <TransitionGroup component={null}>
            {communityCards && communityCards.map((cardStr, index) => {
               const cardKey = `community-${cardStr}-${index}`;
               if (!nodeRefs.current[cardKey]) nodeRefs.current[cardKey] = React.createRef();
               return (
                <CSSTransition
                  key={cardKey}
                  nodeRef={nodeRefs.current[cardKey]}
                  timeout={500}
                  classNames="card-item"
                  unmountOnExit={false} 
                  appear 
                >
                  {renderCard(cardStr, `community-${index}`)}
                </CSSTransition>
              );
            })}
          </TransitionGroup>
          {(!communityCards || communityCards.length === 0) && <p>No cards dealt yet.</p>}
        </div>
        {lastAction && <p className="last-action-display">Last Action: {lastAction}</p>}
      </div>
      
      {error && <p className="error-message">{error}</p>}

      <h3>Players at Table:</h3>
      <div className="players-area">
        {playerMap && Object.keys(playerMap).map((playerId) => {
          const player = playerMap[playerId];
          if (!player) return null;
          return (
            <div key={playerId} className={`player-box ${playerId === currentMyClientId ? 'my-player' : ''} ${actionTo === playerId ? 'action-to' : ''} ${player.folded ? 'folded-player' : ''}`}>
              <h4> {player.nickname} {playerId === currentMyClientId ? '(You)' : ''} {player.isDealer && <span className="role-indicator">(D)</span>} {player.isSB && <span className="role-indicator">(SB)</span>} {player.isBB && <span className="role-indicator">(BB)</span>}</h4>
              <p>Chips: {player.chips}</p><p>Bet this round: {player.betInRound}</p>
              <div className="card-display hand"> Hand: 
                <TransitionGroup component={null}>
                  {(player.hand || []).map((cardStr, cardIndex) => {
                    const cardKey = `player-${playerId}-card-${cardStr}-${cardIndex}`; 
                    if (!nodeRefs.current[cardKey]) nodeRefs.current[cardKey] = React.createRef();
                    return (
                      <CSSTransition
                        key={cardKey}
                        nodeRef={nodeRefs.current[cardKey]}
                        timeout={300}
                        classNames="card-item"
                        appear
                      >
                        {renderCard(cardStr, `player-${playerId}-${cardIndex}`)}
                      </CSSTransition>
                    );
                  })}
                </TransitionGroup>
              </div>
              {player.isAllIn && <p className="all-in-indicator">ALL-IN</p>} {player.folded && <p className="folded-indicator">FOLDED</p>}
            </div>
          );
        })}
      </div>

      {phase !== 'showdown' && phase !== 'waiting_for_players' && phase !== 'game_over' && myPlayerGameState && !myPlayerGameState.folded && !myPlayerGameState.isAllIn && (
        <div className="actions-panel">
          {isMyTurn ? (
            <>
              <h4>Your Turn ({myPlayerGameState.nickname})</h4>
              <button onClick={() => sendGameAction('FOLD')}>Fold</button>
              {canCheck ? (<button onClick={() => sendGameAction('CHECK')}>Check</button>) : (<button onClick={() => sendGameAction('CALL')} disabled={amountToCall <= 0 && currentBet > 0}>Call {amountToCall > 0 ? amountToCall : ''}</button>)}
              <input type="number" value={betAmount} onChange={(e) => setBetAmount(e.target.value)} placeholder="Amount" min={minBetRaiseAmount}/>
              <button onClick={() => sendGameAction('BET', parseInt(betAmount))} disabled={!betAmount || parseInt(betAmount) < minBetRaiseAmount || parseInt(betAmount) > myPlayerGameState.chips}> {currentBet > 0 ? 'Raise' : 'Bet'} </button>
            </>
          ) : (<p>Waiting for {playerMap && actionTo && playerMap[actionTo]?.nickname ? playerMap[actionTo].nickname : (actionTo || 'opponent')}...</p>)}
        </div>
      )}

      {winners && phase === 'showdown' && (
        <div className="winners-info"><h3>Showdown Results:</h3> {winners.map((winner, index) => (<div key={winner.id + index.toString()}><p>{winner.nickname} wins {winner.wonAmount} with {winner.handRank}</p><p>Hand: {(winner.hand || []).map((card, i) => renderCard(card, `winner-${index}-${i}`))}</p></div>))}</div>
      )}
      
      {phase === 'showdown' && (<button onClick={handleRequestNextHand}>Start Next Hand</button>)}
      {(phase === 'waiting_for_players' || phase === 'game_over') && playersInLobby.length >= 1 && currentMyClientId && (<button onClick={handleStartGame}>Start Game</button>)}
    </div>
  );
}

export default PokerRoom;