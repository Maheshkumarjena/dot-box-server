require('dotenv').config()
const express = require('express')
const http = require('http')
const cors = require('cors')
const socketio = require('socket.io')
const prisma = require('./prisma')
const { handleSocketConnection } = require('./socket')

const app = express()
const server = http.createServer(app)
const io = socketio(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
})

app.use(cors())
app.use(express.json())

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' })
})

// Initialize Socket.IO
io.on('connection', (socket) => handleSocketConnection(socket, io, prisma))

const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

process.on('SIGTERM', async () => {
  await prisma.$disconnect()
  process.exit(0)
})