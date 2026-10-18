import { Detail } from '@raycast/api'
import React from 'react'

interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback
      return <Detail markdown={`## devctl extension error\n\n\`\`\`\n${this.state.error.message}\n\`\`\``} />
    }
    return this.props.children
  }
}
