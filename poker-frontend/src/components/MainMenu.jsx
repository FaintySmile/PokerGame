import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

function MainMenu({ wsUrl }) {
  const [roomIdToJoin, setRoomIdToJoin] = useState('');
  const [nickname, setNickname] = useState(localStorage.getItem('pokerNickname_main') || '');
  const [message, setMessage] = useState('');
  const ws = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    
    if (nickname) {
      localStorage.setItem('pokerNickname_main', nickname);
    }
  }, [nickname]);

  useEffect(() => {
    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      setMessage('Connected to server. Enter a nickname to create or join a room.');
    };

    ws.current.onmessage = (event) => {
      const parsedMessage = JSON.parse(event.data);
      if (parsedMessage.type === 'ROOM_CREATED') {
        setMessage(`Room created: ${parsedMessage.payload.roomId}. Joining...`);
        
        
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
             ws.current.send(JSON.stringify({ type: 'JOIN_ROOM', payload: { roomId: parsedMessage.payload.roomId, nickname } }));
        }

      } else if (parsedMessage.type === 'JOINED_ROOM') {
        setMessage(`Joined room: ${parsedMessage.payload.roomId} as ${parsedMessage.payload.nickname}`);
        
        navigate(`/room/${parsedMessage.payload.roomId}`, { 
            state: { 
                nickname: parsedMessage.payload.nickname, 
                
                                                          
            } 
        });
      } else if (parsedMessage.type === 'ROOM_NOT_FOUND') {
        setMessage(`Error: Room ${parsedMessage.payload.roomId} not found.`);
      } else if (parsedMessage.type === 'GAME_ERROR') {
        setMessage(`Error: ${parsedMessage.payload}`);
      }
    };

    ws.current.onclose = () => {
      setMessage('Disconnected from server. Please refresh to reconnect.');
    };
    
    ws.current.onerror = (err) => {
      setMessage('WebSocket error. Check console.');
      console.error("WebSocket Error in MainMenu:", err);
    }

    
    const wsInstance = ws.current;

    return () => {
      if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
        wsInstance.close();
      }
    };
  }, [wsUrl, navigate, nickname]); 

  const handleCreateRoom = () => {
    if (!nickname.trim()) {
      setMessage('Please enter a nickname first.');
      return;
    }
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'CREATE_ROOM' }));
    } else {
      setMessage('Not connected to server. Please refresh.');
    }
  };

  const handleJoinRoom = () => {
    if (!nickname.trim()) {
      setMessage('Please enter a nickname first.');
      return;
    }
    if (!roomIdToJoin.trim()) {
      setMessage('Please enter a Room ID to join.');
      return;
    }
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'JOIN_ROOM', payload: { roomId: roomIdToJoin, nickname } }));
    } else {
      setMessage('Not connected to server. Please refresh.');
    }
  };

  return (
    <div>
      <h2>Main Menu</h2>
      {message && <p>{message}</p>}
      <div>
        <input
          type="text"
          placeholder="Enter Nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        />
      </div>
      <div>
        <button onClick={handleCreateRoom}>Create Room</button>
      </div>
      <hr />
      <div>
        <input
          type="text"
          placeholder="Enter Room ID"
          value={roomIdToJoin}
          onChange={(e) => setRoomIdToJoin(e.target.value)}
        />
        <button onClick={handleJoinRoom}>Join Room</button>
      </div>
    </div>
  );
}

export default MainMenu;