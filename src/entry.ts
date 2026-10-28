import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './styles.css'

import { rootsFromDocument } from './appContext'
import { init } from './main'

init(rootsFromDocument())
