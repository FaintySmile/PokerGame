
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const Hand = require('pokersolver').Hand;

const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocketServer({ server });

const rooms = {};
const ROOM_CLEANUP_INTERVAL = 30000;
const ROOM_INACTIVITY_TIMEOUT = 60000 * 5;
const STARTING_CHIPS = 1000;
const SMALL_BLIND_AMOUNT = 10;
const BIG_BLIND_AMOUNT = 20;

console.log('WebSocket server starting...');

function createDeck() {
    const suits = ['s', 'h', 'd', 'c'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push(rank + suit);
        }
    }
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getPlayerNickname(roomId, clientId) {
    const room = rooms[roomId];
    if (!room) return clientId;
    const player = room.players.find(p => p.id === clientId);
    return player ? player.nickname : clientId;
}

function initializeGameForRoom(roomId) {
    const room = rooms[roomId];
    if (!room || !room.players || room.players.length < 2) {
        broadcastToRoom(roomId, { type: 'GAME_ERROR', payload: 'Not enough players to start (min 2).' });
        return;
    }

    room.gameState = {
        deck: shuffleDeck(createDeck()),
        communityCards: [],
        pot: 0,
        currentPlayerIndex: -1,
        dealerIndex: Math.floor(Math.random() * room.players.length),
        smallBlindIndex: -1,
        bigBlindIndex: -1,
        currentBet: 0,
        minRaise: BIG_BLIND_AMOUNT,
        playerStates: {},
        phase: 'waiting_for_players',
        lastAction: null,
        bettingRoundOpen: true,
        actionTo: null,
        winners: null,
    };

    room.players.forEach(player => {
        if (player && player.id) {
            room.gameState.playerStates[player.id] = {
                hand: [],
                chips: STARTING_CHIPS,
                betInRound: 0,
                hasActedThisRound: false,
                folded: false,
                isAllIn: false,
            };
        }
    });
    
    startNewHand(roomId);
}

function startNewHand(roomId) {
    const room = rooms[roomId];
    if (!room || !room.gameState || !room.gameState.playerStates) return;
    const gs = room.gameState;

    gs.deck = shuffleDeck(createDeck());
    gs.communityCards = [];
    gs.pot = 0;
    gs.winners = null;
    gs.lastAction = "New Hand Starting...";

    if (room.players.length === 0) return; 
    gs.dealerIndex = (gs.dealerIndex + 1) % room.players.length;
    
    let activePlayerCount = 0;
    room.players.forEach(player => {
        if (!player || !player.id) return;
        const pState = gs.playerStates[player.id];
        if (!pState) { 
            gs.playerStates[player.id] = { chips: 0, folded: true, hand: [], betInRound: 0, hasActedThisRound: false, isAllIn: false };
            return;
        }
        if (pState.chips > 0) {
            pState.hand = [];
            pState.betInRound = 0;
            pState.hasActedThisRound = false;
            pState.folded = false;
            pState.isAllIn = false;
            activePlayerCount++;
        } else {
            pState.folded = true;
        }
    });

    if (activePlayerCount < 2) {
        gs.phase = 'game_over';
        gs.lastAction = "Not enough active players with chips to continue.";
        broadcastGameState(roomId);
        return;
    }
    
    gs.smallBlindIndex = (gs.dealerIndex + 1) % room.players.length;
    while(!gs.playerStates[room.players[gs.smallBlindIndex]?.id] || gs.playerStates[room.players[gs.smallBlindIndex].id].chips === 0 || gs.playerStates[room.players[gs.smallBlindIndex].id].folded) {
        gs.smallBlindIndex = (gs.smallBlindIndex + 1) % room.players.length;
    }

    gs.bigBlindIndex = (gs.smallBlindIndex + 1) % room.players.length;
    while(!gs.playerStates[room.players[gs.bigBlindIndex]?.id] || gs.playerStates[room.players[gs.bigBlindIndex].id].chips === 0 || gs.playerStates[room.players[gs.bigBlindIndex].id].folded) {
        gs.bigBlindIndex = (gs.bigBlindIndex + 1) % room.players.length;
    }

    postBlind(roomId, gs.smallBlindIndex, SMALL_BLIND_AMOUNT, "Small Blind");
    postBlind(roomId, gs.bigBlindIndex, BIG_BLIND_AMOUNT, "Big Blind");
    
    gs.currentBet = BIG_BLIND_AMOUNT;

    for (let i = 0; i < 2; i++) {
        room.players.forEach(player => {
            if (!player || !player.id) return;
            const pState = gs.playerStates[player.id];
            if (pState && !pState.folded && pState.chips > 0) {
                if (gs.deck.length > 0) pState.hand.push(gs.deck.pop());
            }
        });
    }

    gs.phase = 'preflop';
    gs.currentPlayerIndex = (gs.bigBlindIndex + 1) % room.players.length;
    while(!gs.playerStates[room.players[gs.currentPlayerIndex]?.id] || gs.playerStates[room.players[gs.currentPlayerIndex].id].folded || gs.playerStates[room.players[gs.currentPlayerIndex].id].chips === 0) {
        gs.currentPlayerIndex = (gs.currentPlayerIndex + 1) % room.players.length;
    }
    if (room.players[gs.currentPlayerIndex]) {
      gs.actionTo = room.players[gs.currentPlayerIndex].id;
    } else {
      gs.actionTo = null; 
    }
    gs.bettingRoundOpen = true;

    broadcastGameState(roomId);
}

function postBlind(roomId, playerIndex, amount, blindType) {
    const room = rooms[roomId];
    if (!room || !room.gameState || !room.gameState.playerStates) return;
    const gs = room.gameState;
    const player = room.players[playerIndex];
    if (!player || !player.id) return;
    const pState = gs.playerStates[player.id];
    if (!pState) return;
    const playerNickname = getPlayerNickname(roomId, player.id);

    const blindAmount = Math.min(pState.chips, amount);
    pState.chips -= blindAmount;
    pState.betInRound += blindAmount;
    gs.pot += blindAmount;
    gs.lastAction = `${playerNickname} posts ${blindType} of ${blindAmount}`;
    if (pState.chips === 0) {
        pState.isAllIn = true;
    }
}

function handlePlayerAction(roomId, clientId, action) {
    const room = rooms[roomId];
    if (!room || !room.gameState || !room.gameState.playerStates || !room.players[room.gameState.currentPlayerIndex] || room.players[room.gameState.currentPlayerIndex].id !== clientId) {
        const playerWs = room.players.find(p => p.id === clientId)?.ws;
        if (playerWs) playerWs.send(JSON.stringify({type: "GAME_ERROR", payload: "Not your turn or game not active."}));
        return;
    }

    const gs = room.gameState;
    const pState = gs.playerStates[clientId];
    if (!pState) return;
    const playerNickname = getPlayerNickname(roomId, clientId);

    if (pState.folded || pState.isAllIn) {
         advanceTurn(roomId);
         return;
    }

    gs.lastAction = `${playerNickname} ${action.type}`;
    pState.hasActedThisRound = true;

    switch (action.type) {
        case 'FOLD':
            pState.folded = true;
            gs.lastAction = `${playerNickname} folds.`;
            break;
        case 'CHECK':
            if (pState.betInRound < gs.currentBet) {
                const playerWs = room.players.find(p => p.id === clientId)?.ws;
                if (playerWs) playerWs.send(JSON.stringify({type: "GAME_ERROR", payload: "Cannot check, must call or raise."}));
                return;
            }
            gs.lastAction = `${playerNickname} checks.`;
            break;
        case 'CALL':
            const amountToCall = gs.currentBet - pState.betInRound;
            if (amountToCall > 0) {
                const callAmount = Math.min(pState.chips, amountToCall);
                pState.chips -= callAmount;
                pState.betInRound += callAmount;
                gs.pot += callAmount;
                gs.lastAction = `${playerNickname} calls ${callAmount}.`;
                if (pState.chips === 0) pState.isAllIn = true;
            } else {
                gs.lastAction = `${playerNickname} calls (effectively checks).`;
            }
            break;
        case 'BET':
            const betAmount = parseInt(action.amount, 10);
            const totalBetInRound = pState.betInRound + betAmount;

            if (isNaN(betAmount) || betAmount <= 0) return;
            if (betAmount > pState.chips) return;
            if (totalBetInRound < gs.currentBet) return;

            pState.chips -= betAmount;
            pState.betInRound += betAmount;
            gs.pot += betAmount;
            gs.currentBet = pState.betInRound;
            gs.lastAction = `${playerNickname} bets/raises ${betAmount}. New total bet: ${gs.currentBet}`;
            if (pState.chips === 0) pState.isAllIn = true;
            
            room.players.forEach(p => {
                if (p.id !== clientId && gs.playerStates[p.id] && !gs.playerStates[p.id].folded && !gs.playerStates[p.id].isAllIn) {
                    gs.playerStates[p.id].hasActedThisRound = false;
                }
            });
            break;
    }
    
    if (checkBettingRoundEnd(roomId)) {
        proceedToNextPhase(roomId);
    } else {
        advanceTurn(roomId);
        console.log(`[SERVER DEBUG] Room ${roomId}, Phase: ${gs.phase}, Action TO: ${gs.actionTo}, Player: ${getPlayerNickname(roomId, gs.actionTo)}`);
        broadcastGameState(roomId);
    }
}

function checkBettingRoundEnd(roomId) {
    const room = rooms[roomId];
    if (!room || !room.gameState) {
        return false;
    }
    const gs = room.gameState;
    if (!gs.bettingRoundOpen) return true;

    if (!gs.playerStates) {
        return false;
    }

    const activePlayers = room.players.filter(p => {
        if (!p || !p.id) return false;
        const pState = gs.playerStates[p.id];
        if (!pState) return false;
        return !pState.folded && pState.chips > 0 && !pState.isAllIn;
    });

    if (activePlayers.length <= 1 && gs.phase !== 'preflop') {
        gs.bettingRoundOpen = false;
        return true;
    }
    
    const allEligiblePlayersActedAndMatched = room.players.every(player => {
        if (!player || !player.id) return true; 
        const pState = gs.playerStates[player.id];
        if (!pState) return true;
        if (pState.folded || pState.isAllIn) return true;
        if (pState.chips === 0 && pState.betInRound > 0) return true;
        return pState.hasActedThisRound && pState.betInRound === gs.currentBet;
    });

    if (allEligiblePlayersActedAndMatched) {
        const playersWhoCanStillAct = room.players.filter(p => {
            if (!p || !p.id) return false;
            const pS = gs.playerStates[p.id];
            if (!pS) return false;
            return !pS.folded && !pS.isAllIn && pS.chips > 0;
        });

        if (playersWhoCanStillAct.length === 0) {
             gs.bettingRoundOpen = false;
             return true;
        }
        if (gs.actionTo && playersWhoCanStillAct.length === 1 && playersWhoCanStillAct[0].id === gs.actionTo) {
            const actionPlayerState = gs.playerStates[gs.actionTo];
            if (actionPlayerState && actionPlayerState.hasActedThisRound && actionPlayerState.betInRound === gs.currentBet) {
                gs.bettingRoundOpen = false;
                return true;
            }
        }
        if (playersWhoCanStillAct.every(p => {
            if (!p || !p.id) return false;
            const pS = gs.playerStates[p.id];
            if (!pS) return false;
            return pS.hasActedThisRound && pS.betInRound === gs.currentBet;
        })) {
             gs.bettingRoundOpen = false;
             return true;
        }
    }
    return false;
}

function advanceTurn(roomId) {
    const room = rooms[roomId];
    if (!room || !room.gameState || !room.gameState.playerStates) {
        return;
    }
    const gs = room.gameState;
    if (!gs.bettingRoundOpen) return;

    if (room.players.length === 0) {
        gs.bettingRoundOpen = false;
        if (gs.phase !== 'showdown' && gs.phase !== 'game_over') {
             determineAndAwardWinners(roomId);
        }
        return;
    }
    
    let nextPlayerIndex = (gs.currentPlayerIndex + 1) % room.players.length;
    const originalStartIndex = gs.currentPlayerIndex;
    let loopedOnce = false;

    while (true) {
        const nextPlayerCandidate = room.players[nextPlayerIndex];
        if (!nextPlayerCandidate || !nextPlayerCandidate.id) {
            gs.bettingRoundOpen = false;
            proceedToNextPhase(roomId);
            return;
        }

        const pState = gs.playerStates[nextPlayerCandidate.id];
        if (pState && !pState.folded && pState.chips > 0 && !pState.isAllIn) {
            break;
        }

        if (nextPlayerIndex === originalStartIndex && loopedOnce) {
            gs.bettingRoundOpen = false;
            proceedToNextPhase(roomId);
            return;
        }

        nextPlayerIndex = (nextPlayerIndex + 1) % room.players.length;
        if (nextPlayerIndex === ( (originalStartIndex + 1) % room.players.length) ) {
            loopedOnce = true;
        }
    }
    gs.currentPlayerIndex = nextPlayerIndex;
    if (room.players[gs.currentPlayerIndex]) {
        gs.actionTo = room.players[gs.currentPlayerIndex].id;
    } else {
        gs.actionTo = null;
    }
}

function proceedToNextPhase(roomId) {
    const room = rooms[roomId];
    if (!room || !room.gameState || !room.gameState.playerStates) return;
    const gs = room.gameState;
    
    room.players.forEach(p => {
        if (!p || !p.id) return;
        const pState = gs.playerStates[p.id];
        if (pState) {
            pState.betInRound = 0;
            if (!pState.folded && !pState.isAllIn && pState.chips > 0) {
                pState.hasActedThisRound = false;
            }
        }
    });
    gs.currentBet = 0;
    gs.minRaise = BIG_BLIND_AMOUNT;
    gs.bettingRoundOpen = true;

    if (room.players.length === 0) return;

    let firstToActIndex = (gs.dealerIndex + 1) % room.players.length;
    let initialFirstToAct = firstToActIndex;
    while(true) {
        const player = room.players[firstToActIndex];
        if (player && player.id && gs.playerStates[player.id] && !gs.playerStates[player.id].folded && gs.playerStates[player.id].chips > 0) {
            break;
        }
        firstToActIndex = (firstToActIndex + 1) % room.players.length;
        if (firstToActIndex === initialFirstToAct) break; 
    }
    gs.currentPlayerIndex = firstToActIndex;
    if (room.players[gs.currentPlayerIndex]) {
       gs.actionTo = room.players[gs.currentPlayerIndex].id;
    } else {
       gs.actionTo = null;
    }


    const activePlayersLeft = room.players.filter(p => {
        if (!p || !p.id) return false;
        const pState = gs.playerStates[p.id];
        return pState && !pState.folded && pState.chips > 0;
    });
    if (activePlayersLeft.length <= 1) {
        determineAndAwardWinners(roomId);
        return;
    }

    switch (gs.phase) {
        case 'preflop':
            gs.phase = 'flop';
            if (gs.deck.length >=3) gs.communityCards.push(gs.deck.pop(), gs.deck.pop(), gs.deck.pop());
            gs.lastAction = `Flop dealt: ${gs.communityCards.join(', ')}`;
            break;
        case 'flop':
            gs.phase = 'turn';
            if (gs.deck.length >=1) gs.communityCards.push(gs.deck.pop());
            gs.lastAction = `Turn card: ${gs.communityCards[gs.communityCards.length -1]}`;
            break;
        case 'turn':
            gs.phase = 'river';
            if (gs.deck.length >=1) gs.communityCards.push(gs.deck.pop());
            gs.lastAction = `River card: ${gs.communityCards[gs.communityCards.length -1]}`;
            break;
        case 'river':
            gs.phase = 'showdown';
            determineAndAwardWinners(roomId);
            return;
        default:
            return;
    }
    
    const nonFoldedPlayers = room.players.filter(p => {
        if (!p || !p.id) return false;
        const pState = gs.playerStates[p.id];
        return pState && !pState.folded;
    });
    const nonFoldedNonAllInPlayers = nonFoldedPlayers.filter(p => {
        if (!p || !p.id) return false;
        const pState = gs.playerStates[p.id];
        return pState && !pState.isAllIn && pState.chips > 0;
    });

    if (nonFoldedPlayers.length > 1 && nonFoldedNonAllInPlayers.length <=1 && gs.phase !== 'showdown') {
        while(gs.phase !== 'river' && gs.communityCards.length < 5) {
             if (gs.phase === 'preflop') {
                if (gs.deck.length >=3) gs.communityCards.push(gs.deck.pop(), gs.deck.pop(), gs.deck.pop());
                gs.phase = 'flop';
             } else if (gs.phase === 'flop') {
                if (gs.deck.length >=1) gs.communityCards.push(gs.deck.pop());
                gs.phase = 'turn';
             } else if (gs.phase === 'turn') {
                if (gs.deck.length >=1) gs.communityCards.push(gs.deck.pop());
                gs.phase = 'river';
             } else {
                break; 
             }
        }
        determineAndAwardWinners(roomId);
    } else {
        broadcastGameState(roomId);
    }
}

function determineAndAwardWinners(roomId) {
    const room = rooms[roomId];
    if (!room || !room.gameState || !room.gameState.playerStates) return;
    const gs = room.gameState;
    gs.phase = 'showdown';
    gs.bettingRoundOpen = false;
    gs.actionTo = null;

    const eligiblePlayers = room.players.filter(p => {
        if (!p || !p.id) return false;
        const pState = gs.playerStates[p.id];
        return pState && !pState.folded;
    });

    if (eligiblePlayers.length === 0) {
        gs.lastAction = "No eligible players for showdown.";
        broadcastGameState(roomId);
        return;
    }
    if (eligiblePlayers.length === 1) {
        const winnerId = eligiblePlayers[0].id;
        const winnerNickname = getPlayerNickname(roomId, winnerId);
        if (gs.playerStates[winnerId]) {
            gs.playerStates[winnerId].chips += gs.pot;
            gs.winners = [{ id: winnerId, nickname: winnerNickname, handRank: "Only one left", wonAmount: gs.pot, hand: gs.playerStates[winnerId].hand || [] }];
        }
        gs.lastAction = `${winnerNickname} wins ${gs.pot} as the only remaining player.`;
        gs.pot = 0;

    } else {
        const playerHands = eligiblePlayers.map(player => {
            if (!player || !player.id || !gs.playerStates[player.id]) return null;
            const pState = gs.playerStates[player.id];
            const hand = Hand.solve((pState.hand || []).concat(gs.communityCards || []));
            hand.clientId = player.id;
            hand.originalHand = pState.hand || [];
            return hand;
        }).filter(h => h !== null); 

        if (playerHands.length === 0) {
            gs.lastAction = "Error determining winners: no valid hands found.";
            broadcastGameState(roomId);
            return;
        }

        const winners = Hand.winners(playerHands);
        
        const potPerWinner = winners.length > 0 ? Math.floor(gs.pot / winners.length) : 0;
        gs.winners = [];

        let winningLog = "Winner(s): ";
        winners.forEach(winnerHand => {
            if (!winnerHand || !winnerHand.clientId) return;
            const winnerId = winnerHand.clientId;
            const winnerNickname = getPlayerNickname(roomId, winnerId);
            if (gs.playerStates[winnerId]) {
                gs.playerStates[winnerId].chips += potPerWinner;
                gs.winners.push({
                    id: winnerId,
                    nickname: winnerNickname,
                    handRank: winnerHand.descr,
                    wonAmount: potPerWinner,
                    hand: winnerHand.originalHand || []
                });
                winningLog += `${winnerNickname} (${winnerHand.descr}) wins ${potPerWinner}. `;
            }
        });
        gs.lastAction = winningLog;
        gs.pot = 0;
    }
    
    broadcastGameState(roomId);
}

function broadcastGameState(roomId) {
    const room = rooms[roomId];
    if (!room || !room.gameState || !room.gameState.playerStates ) {
        return;
    }

    room.players.forEach(playerClient => {
        if (!playerClient || !playerClient.id || !playerClient.ws || playerClient.ws.readyState !== playerClient.ws.OPEN) return;
        
        const tailoredState = {
            communityCards: room.gameState.communityCards,
            pot: room.gameState.pot,
            currentBet: room.gameState.currentBet,
            phase: room.gameState.phase,
            lastAction: room.gameState.lastAction,
            winners: room.gameState.winners,
            actionTo: room.gameState.actionTo,
            myClientId: playerClient.id,
            playerMap: {},
        };

        room.players.forEach(p => {
            if (!p || !p.id) return;
            const pState = room.gameState.playerStates[p.id];
            if (!pState) return;

            let handToShow = ["?", "?"];
            if (p.id === playerClient.id) {
                handToShow = pState.hand || ["?", "?"];
            } else if (room.gameState.phase === 'showdown' && !pState.folded) {
                handToShow = pState.hand || ["?", "?"];
            } else if (room.gameState.phase === 'showdown' && pState.folded) {
                handToShow = ["FOLDED"];
            }

            tailoredState.playerMap[p.id] = {
                nickname: p.nickname,
                chips: pState.chips,
                betInRound: pState.betInRound,
                folded: pState.folded,
                isAllIn: pState.isAllIn,
                hand: handToShow,
                isDealer: room.players[room.gameState.dealerIndex]?.id === p.id,
                isSB: room.players[room.gameState.smallBlindIndex]?.id === p.id,
                isBB: room.players[room.gameState.bigBlindIndex]?.id === p.id,
            };
        });
        playerClient.ws.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', payload: tailoredState }));
    });
}

function broadcastToRoom(roomId, messageObject) {
    const room = rooms[roomId];
    if (room && room.players) {
        room.players.forEach(player => {
            if (player && player.ws && player.ws.readyState === player.ws.OPEN) {
                player.ws.send(JSON.stringify(messageObject));
            }
        });
    }
}

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    ws.clientId = clientId;

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) { return; }

        const { type, payload } = parsedMessage;
        const roomId = ws.roomId || payload?.roomId;

        switch (type) {
            case 'CREATE_ROOM': {
                const newRoomId = uuidv4().slice(0, 8);
                rooms[newRoomId] = { id: newRoomId, players: [], createdAt: Date.now(), gameState: null, lastActivityTime: Date.now() };
                ws.send(JSON.stringify({ type: 'ROOM_CREATED', payload: { roomId: newRoomId } }));
                break;
            }
            case 'JOIN_ROOM': {
                if (!payload || !payload.roomId) return;
                const roomToJoin = rooms[payload.roomId];
                const nickname = payload.nickname || `Player_${clientId.slice(0,4)}`;
                if (roomToJoin) {
                    if (!roomToJoin.players.find(p => p.id === ws.clientId)) {
                        roomToJoin.players.push({ id: ws.clientId, ws, nickname });
                    }
                    ws.roomId = payload.roomId;
                    roomToJoin.lastActivityTime = Date.now();
                    const playerInfo = roomToJoin.players.map(p => ({ id: p.id, nickname: p.nickname }));
                    ws.send(JSON.stringify({ type: 'JOINED_ROOM', payload: { roomId: payload.roomId, clientId: ws.clientId, nickname: nickname, players: playerInfo } }));
                    roomToJoin.players.forEach(p => {
                        if (p.id !== ws.clientId && p.ws.readyState === p.ws.OPEN) {
                            p.ws.send(JSON.stringify({ type: 'PLAYER_JOINED', payload: { roomId: payload.roomId, playerId: ws.clientId, nickname: nickname, players: playerInfo } }));
                        }
                    });
                     if (roomToJoin.gameState) {
                        broadcastGameState(payload.roomId);
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'ROOM_NOT_FOUND', payload: { roomId: payload.roomId } }));
                }
                break;
            }
            case 'START_GAME':
                if (roomId && rooms[roomId]) {
                    rooms[roomId].lastActivityTime = Date.now();
                    initializeGameForRoom(roomId);
                } else {
                    ws.send(JSON.stringify({type: "GAME_ERROR", payload: "Cannot start game: not in a valid room."}));
                }
                break;
            case 'GAME_ACTION':
                if (roomId && rooms[roomId] && rooms[roomId].gameState) {
                    rooms[roomId].lastActivityTime = Date.now();
                    handlePlayerAction(roomId, ws.clientId, payload.action);
                } else {
                     ws.send(JSON.stringify({type: "GAME_ERROR", payload: "Cannot perform action: game not active or not in room."}));
                }
                break;
            case 'REQUEST_NEXT_HAND':
                if (roomId && rooms[roomId] && rooms[roomId].gameState && rooms[roomId].gameState.phase === 'showdown') {
                    rooms[roomId].lastActivityTime = Date.now();
                    startNewHand(roomId);
                }
                break;

            default: {}
        }
    });

    ws.on('close', () => {
        const currentRoomId = ws.roomId;
        if (currentRoomId && rooms[currentRoomId]) {
            const room = rooms[currentRoomId];
            room.lastActivityTime = Date.now();
            const playerIndex = room.players.findIndex(p => p.id === ws.clientId);

            if (playerIndex > -1) {
                const disconnectedPlayer = room.players.splice(playerIndex, 1)[0];
                const playerNickname = disconnectedPlayer.nickname;
                const playerInfo = room.players.map(p => ({ id: p.id, nickname: p.nickname }));
                
                if (room.gameState && room.gameState.playerStates && room.gameState.playerStates[ws.clientId]) {
                    room.gameState.playerStates[ws.clientId].folded = true;
                    if (room.gameState.lastAction !== undefined) {
                       room.gameState.lastAction = `${playerNickname} disconnected and folded.`;
                    } else {
                       room.gameState.lastAction = `${playerNickname} disconnected.`;
                    }

                    if (room.gameState.actionTo === ws.clientId) {
                         if (checkBettingRoundEnd(currentRoomId)) {
                            proceedToNextPhase(currentRoomId);
                        } else {
                            advanceTurn(currentRoomId);
                        }
                    }
                } else if (room.gameState) {
                     if (room.gameState.lastAction !== undefined) {
                        room.gameState.lastAction = `${playerNickname} disconnected.`;
                     }
                }

                room.players.forEach(p => {
                    if (p.ws.readyState === p.ws.OPEN) {
                        p.ws.send(JSON.stringify({ type: 'PLAYER_LEFT', payload: { roomId: currentRoomId, playerId: ws.clientId, nickname: playerNickname, players: playerInfo } }));
                    }
                });
                 if(room.gameState) broadcastGameState(currentRoomId);
            }
        }
    });
    ws.on('error', (error) => { console.error(`[WEBSOCKET_ERROR] For client ${ws.clientId}:`, error); });
});

function cleanupInactiveRooms() {
    const now = Date.now();
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (!room) continue;

        if (room.players.length === 0 && (now - (room.createdAt || 0) > ROOM_INACTIVITY_TIMEOUT / 2)) {
            delete rooms[roomId];
        } else {
            const lastActivity = room.lastActivityTime || room.createdAt || 0;
            if (now - lastActivity > ROOM_INACTIVITY_TIMEOUT) {
                if (!room.gameState || room.gameState.phase === 'game_over' || room.gameState.phase === 'waiting_for_players' || room.players.length === 0) {
                    broadcastToRoom(roomId, { type: 'ROOM_CLOSED', payload: { message: 'Room closed due to inactivity.' }});
                    delete rooms[roomId];
                }
            }
        }
    }
}
setInterval(cleanupInactiveRooms, ROOM_CLEANUP_INTERVAL);

server.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
    console.log(`WebSocket server is listening on ws://localhost:${PORT}`);
});