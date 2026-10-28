import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CategoryNode } from '@/types/categories'

const categoriesService = vi.hoisted(() => ({
  createCategory: vi.fn(),
  deleteCategory: vi.fn(),
  getCategoryDeleteImpact: vi.fn(),
  listCategories: vi.fn(),
  moveCategory: vi.fn(),
  renameCategory: vi.fn(),
  toCategoryError: vi.fn((error: unknown) => error),
}))

vi.mock('@/services/categories', () => categoriesService)

import CategoriesView from '@/views/CategoriesView.vue'

interface TestTreeNode {
  data: CategoryNode
  level: number
  parent: TestTreeNode | null
  childNodes: TestTreeNode[]
}

function category(id: string, parentId?: string, children: CategoryNode[] = []): CategoryNode {
  return {
    id,
    name: id,
    parentId,
    level: parentId === undefined ? 1 : 2,
    sortOrder: 0,
    path: id,
    noteCount: 0,
    children,
  }
}

function createTestRouter() {
  const emptyView = { template: '<div />' }
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'workbench', component: emptyView },
      { path: '/categories', name: 'categories', component: emptyView },
      { path: '/tags', name: 'tags', component: emptyView },
      { path: '/trash', name: 'trash', component: emptyView },
      { path: '/search', name: 'search', component: emptyView },
      { path: '/settings', name: 'settings', component: emptyView },
    ],
  })
}

async function mountView() {
  const pinia = createPinia()
  const router = createTestRouter()
  setActivePinia(pinia)
  await router.push('/categories')
  await router.isReady()
  const wrapper = mount(CategoriesView, {
    global: {
      plugins: [pinia, router],
      stubs: {
        ExportDialog: true,
        ElButton: {
          template: '<button><slot /></button>',
        },
        ElIcon: {
          template: '<i><slot /></i>',
        },
        ElScrollbar: {
          template: '<div><slot /></div>',
        },
        ElTree: {
          name: 'ElTree',
          emits: ['node-drop'],
          template: '<div />',
        },
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('CategoriesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    categoriesService.listCategories.mockReset()
    categoriesService.moveCategory.mockReset()
    categoriesService.moveCategory.mockResolvedValue(undefined)
    categoriesService.toCategoryError.mockImplementation((error: unknown) => error)
  })

  it('管理页分类加号携带目标分类跳转到新建笔记流程', async () => {
    categoriesService.listCategories.mockResolvedValue([category('work')])
    const wrapper = await mountView()

    await wrapper.get('.sidebar-category-create').trigger('click')
    await flushPromises()

    expect(wrapper.findComponent({ name: 'AppSidebar' }).vm.$route.query).toEqual({
      category: 'work',
      create: '1',
    })
  })

  it('跨层移动后持久化真实顺序并同步更新侧栏', async () => {
    const existing = category('existing', 'target')
    const source = category('source')
    const target = category('target', undefined, [existing])
    const movedSource = { ...source, parentId: 'target', level: 2, path: 'target / source' }
    categoriesService.listCategories
      .mockResolvedValueOnce([source, target])
      .mockResolvedValueOnce([category('target', undefined, [existing, movedSource])])
    const wrapper = await mountView()

    const movedNode: TestTreeNode = {
      data: movedSource,
      level: 2,
      parent: null,
      childNodes: [],
    }
    const targetNode: TestTreeNode = {
      data: target,
      level: 1,
      parent: null,
      childNodes: [{ data: existing, level: 2, parent: null, childNodes: [] }, movedNode],
    }

    wrapper.findComponent({ name: 'ElTree' }).vm.$emit('node-drop', movedNode, targetNode, 'inner')
    await flushPromises()

    expect(categoriesService.moveCategory).toHaveBeenCalledWith('source', 'target', ['existing', 'source'])
    expect(wrapper.findAll('.sidebar-category-name').map((item) => item.text())).toEqual([
      '未分类',
      'target',
      'existing',
      'source',
    ])
  })

  it('同级拖拽后按新顺序更新根分类和侧栏', async () => {
    const first = category('first')
    const second = category('second')
    categoriesService.listCategories.mockResolvedValueOnce([first, second]).mockResolvedValueOnce([second, first])
    const wrapper = await mountView()
    const rootNode: TestTreeNode = {
      data: category('root'),
      level: 0,
      parent: null,
      childNodes: [],
    }
    const firstNode: TestTreeNode = {
      data: first,
      level: 1,
      parent: null,
      childNodes: [],
    }
    const secondNode: TestTreeNode = {
      data: second,
      level: 1,
      parent: rootNode,
      childNodes: [],
    }
    rootNode.childNodes = [secondNode, firstNode]

    wrapper.findComponent({ name: 'ElTree' }).vm.$emit('node-drop', firstNode, secondNode, 'after')
    await flushPromises()

    expect(categoriesService.moveCategory).toHaveBeenCalledWith('first', undefined, ['second', 'first'])
    expect(wrapper.findAll('.sidebar-category-name').map((item) => item.text())).toEqual(['未分类', 'second', 'first'])
  })
})
