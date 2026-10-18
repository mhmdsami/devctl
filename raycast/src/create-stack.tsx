import { ErrorBoundary } from './lib/ErrorBoundary'
import { StackForm } from './stack-form'

export default function CreateStack() {
  return (
    <ErrorBoundary>
      <StackForm />
    </ErrorBoundary>
  )
}
