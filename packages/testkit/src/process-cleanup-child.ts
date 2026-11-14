// Loaded only in children of an instrumented test process; never installed in a real runner service.
import { installProcessTracking } from './process-cleanup';
installProcessTracking();
