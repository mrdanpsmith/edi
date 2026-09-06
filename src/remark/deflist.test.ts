import { describe, expect, it } from 'vitest'
import {
  descriptionDetailsNode,
  descriptionListNode,
  descriptionTermNode,
  remarkPlugin,
} from './deflist'

describe('remark/deflist', () => {
  it('exposes the remark plugin', () => {
    expect(remarkPlugin).toBeDefined()
    expect(typeof remarkPlugin).toBe('function')
  })

  it('defines a description_list node that maps <dl>', () => {
    expect(descriptionListNode.group).toBe('block')
    expect(descriptionListNode.defining).toBe(true)
    expect(descriptionListNode.content).toBe('(descriptionterm descriptiondetails*)+')
    expect(descriptionListNode.parseDOM).toEqual([{ tag: 'dl' }])
    expect(descriptionListNode.toDOM()).toEqual(['dl', 0])
  })

  it('defines a description_term node that maps <dt>', () => {
    expect(descriptionTermNode.content).toBe('inline*')
    expect(descriptionTermNode.parseDOM).toEqual([{ tag: 'dt' }])
    expect(descriptionTermNode.toDOM()).toEqual(['dt', 0])
  })

  it('defines a description_details node that maps <dd>', () => {
    expect(descriptionDetailsNode.content).toBe('block+')
    expect(descriptionDetailsNode.parseDOM).toEqual([{ tag: 'dd' }])
    expect(descriptionDetailsNode.toDOM()).toEqual(['dd', 0])
  })
})