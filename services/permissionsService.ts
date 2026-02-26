// Compatibility shim — logic has moved to lib/security
import { permissionsService } from '@/lib/security'

export {
  permissionsService,
  ROLE_NAVIGATION,
} from '@/lib/security'
export type {
  Permission,
  UserAccessContext,
  UserSubType,
} from '@/lib/security'
export default permissionsService
