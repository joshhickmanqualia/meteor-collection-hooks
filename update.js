import { EJSON } from 'meteor/ejson'
import { CollectionHooks } from './collection-hooks'

const isEmpty = a => !Array.isArray(a) || !a.length

CollectionHooks.defineAdvice('update', function (userId, _super, instance, aspects, getTransform, args, suppressAspects) {
  const ctx = { context: this, _super, args }
  let [selector, mutator, options, callback] = args
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  const async = typeof callback === 'function'
  let docs
  let docIds
  let fields
  let abort
  const prev = {}

  if (!suppressAspects) {
    try {
      if (!isEmpty(aspects.before) || !isEmpty(aspects.after)) {
        fields = CollectionHooks.getFields(mutator)
        docs = CollectionHooks.getDocs.call(this, instance, selector, options).fetch()
        docIds = docs.map(doc => doc._id)
      }

      // copy originals for convenience for the 'after' pointcut
      if (!isEmpty(aspects.after)) {
        prev.mutator = EJSON.clone(mutator)
        prev.options = EJSON.clone(options)
        if (
          aspects.after.some(o => o.options.fetchPrevious !== false) &&
          CollectionHooks.extendOptions(instance.hookOptions, {}, 'after', 'update').fetchPrevious !== false
        ) {
          prev.docs = {}
          docs.forEach((doc) => {
            prev.docs[doc._id] = EJSON.clone(doc)
          })
        }
      }

      // before
      let mutators = new Map();
      aspects.before.forEach(function (o) {
        docs.forEach(function (doc) {
          let localMutator = EJSON.clone(mutator)
          // We need to stop returning false on noop updates, or make this just ignore those
          const r = o.aspect.call({ transform: getTransform(doc), ...ctx }, userId, doc, fields, localMutator, options)
          let recordsForThisMutator = mutators.get(localMutator) || []
          recordsForThisMutator.push(doc)
          mutators.set(localMutator, recordsForThisMutator)
          if (r === false) abort = true
        })
      })

      if (abort) return 0
      if (mutators.size > 1) {
        for (const [mutator, docsThatNeedIt] in mutators) {
          instance.update({_id: {$in: docsThatNeedIt.map(doc => doc._id)}}, mutator)
        }

        return 0; // we need to cancel the underlying op, it will NEVER work with multiple intended mutators.
      } else if (mutators.size === 1) {
        // modify the mutator object to be the one returned.
        for (let field in mutator) {
          if (mutator.hasOwnProperty(field)) {
            delete mutator[field]
          }
        }
        let newMutator = mutators.keys()[0]
        for (let newMutField in newMutator) {
          if (newMutator.hasOwnProperty(newMutField)) {
            mutator[newMutField] = newMutator[newMutField];
          }
        }
      }
    } catch (e) {
      if (async) return callback.call(this, e)
      throw e
    }
  }

  const after = (affected, err) => {
    if (!suppressAspects && !isEmpty(aspects.after)) {
      const fields = CollectionHooks.getFields(mutator)
      const docs = CollectionHooks.getDocs.call(this, instance, { _id: { $in: docIds } }, options).fetch()

      aspects.after.forEach((o) => {
        docs.forEach((doc) => {
          o.aspect.call({
            transform: getTransform(doc),
            previous: prev.docs && prev.docs[doc._id],
            affected,
            err,
            ...ctx
          }, userId, doc, fields, prev.mutator, prev.options)
        })
      })
    }
  }

  if (async) {
    const wrappedCallback = function (err, affected, ...args) {
      after(affected, err)
      return callback.call(this, err, affected, ...args)
    }
    return _super.call(this, selector, mutator, options, wrappedCallback)
  } else {
    const affected = _super.call(this, selector, mutator, options, callback)
    after(affected)
    return affected
  }
})
