const { v4: uuidv4 } = require('uuid')

// In-memory store for active games
const activeGames = {}

// Generate a random 6-character game code
const generateGameCode = () => {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length))
  }
  return result
}

// Initialize a new game state
const initializeGameState = (gridSize, players, gameId, code) => {
  const lines = {}
  const boxes = {}

  // Initialize all possible lines and boxes
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      // Horizontal lines (row_col-row_col+1)
      if (col < gridSize - 1) {
        const lineId = `${row}-${col}_${row}-${col + 1}`
        lines[lineId] = { drawn: false, playerId: null }
      }
      // Vertical lines (row_col-row+1_col)
      if (row < gridSize - 1) {
        const lineId = `${row}-${col}_${row + 1}-${col}`
        lines[lineId] = { drawn: false, playerId: null }
      }
      // Boxes (row_col)
      if (row < gridSize - 1 && col < gridSize - 1) {
        const boxId = `${row}-${col}`
        boxes[boxId] = { owner: null }
      }
    }
  }

  return {
    gridSize,
    players,
    gameId,
    code,
    lines,
    boxes,
    currentPlayerIndex: 0,
    scores: players.reduce((acc, player) => {
      acc[player.userId] = 0
      return acc
    }, {}),
    createdAt: new Date().toISOString(),
  }
}

// Handle a move in the game
const processMove = (gameState, lineId, playerId) => {
  const { lines, boxes, currentPlayerIndex, players } = gameState
  const line = lines[lineId]

  // Validate the move
  if (!line || line.drawn) return { valid: false, message: 'Invalid move' }
  if (players[currentPlayerIndex].userId !== playerId) {
    return { valid: false, message: 'Not your turn' }
  }

  // Mark the line as drawn
  line.drawn = true
  line.playerId = playerId

  let boxesCompleted = 0

  // Check if any boxes were completed
  const [dot1, dot2] = lineId.split('_')
  const [row1, col1] = dot1.split('-').map(Number)
  const [row2, col2] = dot2.split('-').map(Number)

  // For horizontal lines, check boxes above and below
  if (row1 === row2) {
    // Check box above
    if (row1 > 0) {
      const boxId = `${row1 - 1}-${col1}`
      if (checkBoxCompletion(gameState, boxId, playerId)) {
        boxesCompleted++
      }
    }
    // Check box below
    if (row1 < gameState.gridSize - 1) {
      const boxId = `${row1}-${col1}`
      if (checkBoxCompletion(gameState, boxId, playerId)) {
        boxesCompleted++
      }
    }
  }
  // For vertical lines, check boxes to the left and right
  else if (col1 === col2) {
    // Check box to the left
    if (col1 > 0) {
      const boxId = `${row1}-${col1 - 1}`
      if (checkBoxCompletion(gameState, boxId, playerId)) {
        boxesCompleted++
      }
    }
    // Check box to the right
    if (col1 < gameState.gridSize - 1) {
      const boxId = `${row1}-${col1}`
      if (checkBoxCompletion(gameState, boxId, playerId)) {
        boxesCompleted++
      }
    }
  }

  // Update scores and turn if no boxes were completed
  if (boxesCompleted > 0) {
    gameState.scores[playerId] += boxesCompleted
  } else {
    gameState.currentPlayerIndex = (currentPlayerIndex + 1) % players.length
  }

  return { valid: true, boxesCompleted }
}

// Check if a box is completed and update it if so
const checkBoxCompletion = (gameState, boxId, playerId) => {
  const { boxes, lines, gridSize } = gameState
  const box = boxes[boxId]
  if (box.owner) return false // Already claimed

  const [row, col] = boxId.split('-').map(Number)

  // Check all four sides of the box
  const topLine = `${row}-${col}_${row}-${col + 1}`
  const rightLine = `${row}-${col + 1}_${row + 1}-${col + 1}`
  const bottomLine = `${row + 1}-${col}_${row + 1}-${col + 1}`
  const leftLine = `${row}-${col}_${row + 1}-${col}`

  if (
    lines[topLine]?.drawn &&
    lines[rightLine]?.drawn &&
    lines[bottomLine]?.drawn &&
    lines[leftLine]?.drawn
  ) {
    box.owner = playerId
    return true
  }

  return false
}

// Check if the game has ended (all lines drawn)
const checkGameEnd = (gameState) => {
  return Object.values(gameState.lines).every(line => line.drawn)
}

// Handle socket connections
const handleSocketConnection = (socket, io, prisma) => {
  console.log(`New connection: ============================================================================================================================================> ${socket.id}`)

  // Create a new game
  socket.on('createGame', async ({ gridSize, userId, username }) => {
    console.log(`[createGame] =====================================================================================> Received createGame request: gridSize=${gridSize}, userId=${userId}, username=${username}`)
    try {
      // Check if the user exists
      let user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) {
        // Create the user if they don't exist
        user = await prisma.user.create({ data: { id: userId, username } })
      }

      // Generate a unique game code
      let code
      let existingGame
      do {
        code = generateGameCode()
        existingGame = await prisma.game.findUnique({ where: { code } })
      } while (existingGame)

      // Create the game in the database
      const game = await prisma.game.create({
        data: {
          code,
          gridSize,
          players: {
            create: {
              user: { connect: { id: userId } },
            },
          },
        },
        include: {
          players: {
            include: {
              user: true,
            },
          },
        },
      })

      // Initialize the game state in memory
      const gameState = initializeGameState(gridSize, game.players, game.id, code)
      activeGames[code] = gameState

      // Join the game room
      socket.join(code)

      // Send the game code and initial state to the host
      socket.emit('gameCreated', {
        code,
        gameState,
      })
    } catch (error) {
      console.error('Error creating game:', error)
      socket.emit('error', { message: 'Failed to create game' })
    }
  })

  // Join an existing game
  socket.on('joinGame', async ({ code, userId, username }) => {
    console.log(`[joinGame]=====================================================================================> Received joinGame request for code: ${code}, userId: ${userId} , username: ${username}`);
    try {
      // Find the game in the database
      console.log(`[joinGame] Finding game in database with code: ${code}`);
      const game = await prisma.game.findUnique({
        where: { code },
        include: {
          players: {
            include: {
              user: true,
            },
          },
        },
      });

      if (!game) {
        console.log(`[joinGame] Game not found with code: ${code}`);
        return socket.emit('error', { message: 'Game not found' });
      }
      console.log(`[joinGame] Found game: ${JSON.stringify(game)}`);

      if (game.status !== 'ACTIVE') {
        console.log(`[joinGame] Game is not active. Status: ${game.status}`);
        return socket.emit('error', { message: 'Game is not active' });
      }
      console.log(`[joinGame] Game is active`);

      // Check if player is already in the game
      const existingPlayer = game.players.find(p => p.userId === userId);
      let player = existingPlayer;
      console.log(`[joinGame] Existing player: ${JSON.stringify(existingPlayer)}`);

      // If not, add them to the game
      if (!existingPlayer) {
        console.log(`[joinGame] Player not found in game, creating new player`);
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
          console.log(`[joinGame] User not found, creating user with id: ${userId} and username: ${username}`);
          const name = username; // Generate a default username
          const user = await prisma.user.create({
            data: {
              id: userId, // Use the provided userId
              username: name, // Pass the username value
            },
          });
          console.log(`[joinGame] Created user: ${JSON.stringify(user)}`);
        }



        player = await prisma.gamePlayer.create({
          data: {
            gameId: game.id,
            userId,
            score: 0,
          },
          include: {
            user: true,
          },
        });
        console.log(`[joinGame] Created new player: ${JSON.stringify(player)}`);

        // Update the in-memory game state
        if (activeGames[code]) {
          activeGames[code].players.push(player);
          console.log(`[joinGame] Updated activeGames[${code}]: ${JSON.stringify(activeGames[code])}`);
        } else {
          console.log(`[joinGame] activeGames[${code}] is undefined.  Current activeGames: ${JSON.stringify(activeGames)}`);
        }
      } else {
        console.log(`[joinGame] Player already exists in the game: ${JSON.stringify(player)}`);
      }

      // Join the game room
      socket.join(code);
      console.log(`[joinGame] Socket joined room: ${code}`);

      // Send the initial game state to the joining player
      const gameStateToSend = activeGames[code] || initializeGameState(game.gridSize, game.players, game.id, code);
      socket.emit('gameJoined', {
        gameState: gameStateToSend,
        player,
      });
      console.log(`[joinGame] Emitted 'gameJoined' event: ${JSON.stringify({ gameState: gameStateToSend, player })}`);

      // Notify other players in the game
      socket.to(code).emit('playerJoined', {
        player,
        gameState: activeGames[code],
      });
      console.log(`[joinGame] Emitted 'playerJoined' event to room ${code}: ${JSON.stringify({ player, gameState: activeGames[code] })}`);
    } catch (error) {
      console.error('[joinGame] Error joining game:', error);
      socket.emit('error', { message: 'Failed to join game' });
    }
  });


  // Make a move in the game
  socket.on('makeMove', ({ code, line, userId }) => {
    const gameState = activeGames[code]
    if (!gameState) {
      return socket.emit('error', { message: 'Game not found' })
    }

    const result = processMove(gameState, line, userId)
    if (!result.valid) {
      return socket.emit('invalidMove', { message: result.message })
    }

    // Check if the game has ended
    const gameEnded = checkGameEnd(gameState)

    if (gameEnded) {
      // Determine the winner
      let winnerId = null
      let maxScore = -1
      let isTie = false

      for (const [playerId, score] of Object.entries(gameState.scores)) {
        if (score > maxScore) {
          maxScore = score
          winnerId = playerId
          isTie = false
        } else if (score === maxScore) {
          isTie = true
        }
      }

      // Update the game in the database
      prisma.game.update({
        where: { code },
        data: {
          status: 'COMPLETED',
          winnerId: isTie ? null : winnerId,
        },
      }).catch(console.error)

      // Notify all players
      io.to(code).emit('gameEnded', {
        winnerId: isTie ? null : winnerId,
        isTie,
        finalScores: gameState.scores,
      })

      // Remove the game from active games
      delete activeGames[code]
    } else {
      // Broadcast the updated game state to all players
      io.to(code).emit('gameStateUpdated', { gameState })

      // Notify whose turn it is
      const currentPlayer = gameState.players[gameState.currentPlayerIndex]
      io.to(code).emit('nextPlayer', { playerId: currentPlayer.userId })
    }
  })

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)
    // TODO: Handle player disconnection (mark as inactive, etc.)
  })
}

module.exports = {
  handleSocketConnection,
  generateGameCode,
  initializeGameState,
  processMove,
  checkBoxCompletion,
  checkGameEnd,
}