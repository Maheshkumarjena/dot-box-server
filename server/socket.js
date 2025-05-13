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

  // Initialize players with scores
  const playersWithScores = players.map(p => ({ ...p, score: 0 }))

  return {
    gridSize,
    players: playersWithScores,
    gameId,
    code,
    lines,
    boxes,
    currentPlayerIndex: 0,
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

  // Update player score if boxes were completed
  if (boxesCompleted > 0) {
    const playerIndex = gameState.players.findIndex(p => p.userId === playerId)
    if (playerIndex !== -1) {
      gameState.players[playerIndex].score += boxesCompleted
    }
  } else {
    gameState.currentPlayerIndex = (currentPlayerIndex + 1) % players.length
  }

  return { valid: true, boxesCompleted }
}

// Check if a box is completed and update it if so
const checkBoxCompletion = (gameState, boxId, playerId) => {
  const { boxes, lines } = gameState
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
  console.log(`New connection: ${socket.id}`)

  // Create a new game
  socket.on('createGame', async ({ gridSize, userId, username }) => {
    try {
      // Check if the user exists
      let user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) {
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
    try {
      // Find the game in the database
      const game = await prisma.game.findUnique({
        where: { code },
        include: {
          players: {
            include: {
              user: true,
            },
          },
        },
      })

      if (!game) {
        return socket.emit('error', { message: 'Game not found' })
      }

      if (game.status !== 'ACTIVE') {
        return socket.emit('error', { message: 'Game is not active' })
      }

      // Check if player is already in the game
      const existingPlayer = game.players.find(p => p.userId === userId)
      let player = existingPlayer

      // If not, add them to the game
      if (!existingPlayer) {
        let user = await prisma.user.findUnique({ where: { id: userId } })
        if (!user) {
          user = await prisma.user.create({
            data: {
              id: userId,
              username: username || `Player${game.players.length + 1}`,
            },
          })
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
        })

        // Update the in-memory game state
        if (activeGames[code]) {
          activeGames[code].players.push(player)
        }
      }

      // Join the game room
      socket.join(code)

      // Send the initial game state to the joining player
      const gameStateToSend = activeGames[code] || initializeGameState(game.gridSize, game.players, game.id, code)
      socket.emit('gameJoined', {
        gameState: gameStateToSend,
        player,
      })

      // Notify other players in the game
      socket.to(code).emit('playerJoined', {
        player,
        gameState: activeGames[code],
      })
    } catch (error) {
      console.error('Error joining game:', error)
      socket.emit('error', { message: 'Failed to join game' })
    }
  })

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

  // Broadcast the updated game state to all players
  io.to(code).emit('gameStateUpdated', { gameState })

  if (gameEnded) {
    // Notify that game has completed (frontend will calculate winner)
    io.to(code).emit('gameCompleted', { 
      finalState: gameState,
      // Optional: include completion timestamp
      completedAt: new Date().toISOString() 
    })

    // Update database but keep in activeGames for a while
    prisma.game.update({
      where: { code },
      data: { status: 'COMPLETED' }
    }).catch(console.error)

    // Schedule cleanup after delay (e.g., 30 seconds)
    setTimeout(() => {
      if (activeGames[code]) {
        delete activeGames[code]
        console.log(`Cleaned up game ${code}`)
      }
    }, 30000)
  } else {
    // Normal move - notify next player
    const currentPlayer = gameState.players[gameState.currentPlayerIndex]
    io.to(code).emit('nextPlayer', { playerId: currentPlayer.userId })
  }
})

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)
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