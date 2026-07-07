package engine

import (
	"container/list"
	"sync"
)

// planeCache is a byte-budgeted LRU of derived []float32 planes.
type planeCache struct {
	mu     sync.Mutex
	budget int64
	used   int64
	items  map[string]*list.Element
	order  *list.List // front = most recent
}

type planeItem struct {
	key  string
	data []float32
}

func newPlaneCache(budget int64) *planeCache {
	return &planeCache{budget: budget, items: map[string]*list.Element{}, order: list.New()}
}

func (c *planeCache) get(key string) ([]float32, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(el)
	return el.Value.(*planeItem).data, true
}

func (c *planeCache) put(key string, data []float32) {
	size := int64(len(data)) * 4
	if size > c.budget {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.order.MoveToFront(el)
		return
	}
	c.items[key] = c.order.PushFront(&planeItem{key: key, data: data})
	c.used += size
	for c.used > c.budget {
		back := c.order.Back()
		it := back.Value.(*planeItem)
		c.order.Remove(back)
		delete(c.items, it.key)
		c.used -= int64(len(it.data)) * 4
	}
}
