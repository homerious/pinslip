package notes

import (
	"errors"

	"pinslip/service/internal/storage"
)

var ErrRevisionConflict = errors.New("note revision conflict")

func (s *Service) GetVersioned(id string) (*Note, string, error) {
	item, revision, err := s.store.LoadVersioned(id)
	if err != nil {
		return nil, "", err
	}
	return toNote(item.FM, item.Body, item.Inbox, item.Folder), revision, nil
}

func (s *Service) loadForSave(id, expectedRevision string) (storage.Item, error) {
	if expectedRevision == "" {
		fm, body, inbox, folder, err := s.store.Load(id)
		return storage.Item{FM: fm, Body: body, Inbox: inbox, Folder: folder}, err
	}
	item, current, err := s.store.LoadVersioned(id)
	if err == nil && current != expectedRevision {
		err = ErrRevisionConflict
	}
	return item, err
}

// EditExisting performs a read-modify-write without upserting a missing note.
// A non-nil note alongside an error means the save succeeded before a legacy move or
// its readback failed. New callers can move independently with MoveExisting.
func (s *Service) EditExisting(id, expectedRevision string, folder *string, edit func(*Note) (SaveInput, error)) (*Note, error) {
	if folder != nil {
		if err := storage.ValidateFolder(*folder); err != nil {
			return nil, err
		}
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	current, revision, err := s.GetVersioned(id)
	if err != nil {
		return nil, err
	}
	if expectedRevision != "" && revision != expectedRevision {
		return nil, ErrRevisionConflict
	}
	in, err := edit(current)
	if err != nil {
		return nil, err
	}
	saved, err := s.save(id, in, revision)
	if err != nil || folder == nil {
		return saved, err
	}
	if err := s.store.Move(id, *folder); err != nil {
		return saved, err
	}
	moved, err := s.Get(id)
	if err != nil {
		return saved, err
	}
	return moved, nil
}

func (s *Service) MoveExisting(id, folder, expectedRevision string) (*Note, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.loadForSave(id, expectedRevision); err != nil {
		return nil, err
	}
	moveErr := s.store.Move(id, folder)
	note, readErr := s.Get(id)
	if moveErr != nil {
		return note, moveErr
	}
	return note, readErr
}

func (s *Service) DeleteExisting(id, expectedRevision string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if expectedRevision != "" {
		if _, err := s.loadForSave(id, expectedRevision); err != nil {
			return err
		}
	}
	if err := s.store.TrashNote(id); err != nil {
		return err
	}
	return s.idx.Delete(id)
}
