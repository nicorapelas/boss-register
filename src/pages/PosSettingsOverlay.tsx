import { useNavigate } from 'react-router-dom'
import { PosSettingsPanel } from './PosSettings'

export function PosSettingsOverlay() {
  const navigate = useNavigate()

  return (
    <div className="pos-settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <PosSettingsPanel onClose={() => navigate('/', { replace: true })} />
    </div>
  )
}
